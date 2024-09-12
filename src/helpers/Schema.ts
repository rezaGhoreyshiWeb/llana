import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { plainToInstance } from 'class-transformer'
import { IsBoolean, IsDateString, IsJSON, IsNumber, IsOptional, IsString, validate } from 'class-validator'
import { isObject } from 'lodash'

import { NON_FIELD_PARAMS } from '../app.constants'
import { MySQL } from '../databases/mysql.database'
import {
	DatabaseColumnType,
	DatabaseFindOneOptions,
	DatabaseJoinType,
	DatabaseRelations,
	DatabaseSchema,
	DatabaseType,
	DatabaseWhere,
	WhereOperator,
} from '../types/database.types'
import {
	SortCondition,
	ValidateFieldsResponse,
	validateRelationsResponse,
	ValidateSortResponse,
	validateWhereResponse,
} from '../types/schema.types'
import { Logger } from './Logger'

@Injectable()
export class Schema {
	constructor(
		private readonly logger: Logger,
		private readonly configService: ConfigService,
		private readonly mysql: MySQL,
	) {}

	/**
	 * Get Table Schema
	 */

	async getSchema(options: { table: string; x_request_id?: string }): Promise<DatabaseSchema> {
		if (!options.table) {
			throw new Error('Table name not provided')
		}

		try {
			let result: DatabaseSchema

			switch (this.configService.get<string>('database.type')) {
				case DatabaseType.MYSQL:
					result = await this.mysql.getSchema({ table: options.table, x_request_id: options.x_request_id })
					break
				default:
					this.logger.error(
						`${options.x_request_id ? '[' + options.x_request_id + ']' : ''}[Query][GetSchema] Database type ${this.configService.get<string>('database.type')} not supported yet`,
					)
			}

			return {
				...result,
				_x_request_id: options.x_request_id,
			}
		} catch (e) {
			this.logger.error(
				`${options.x_request_id ? '[' + options.x_request_id + ']' : ''}[Query][GetSchema] ${e.message}`,
			)
			throw new Error(`Error processing schema for ${options.table}`)
		}
	}

	/**
	 * The primary key's name of the table
	 */
	getPrimaryKey(schema: DatabaseSchema): string {
		return schema.columns.find(column => {
			if (column.primary_key) {
				return column
			}
		}).field
	}

	/**
	 * Get the class for the schema
	 */

	schemaToClass(schema: DatabaseSchema, data?: { [key: string]: any }): any {
		class DynamicClass {}

		for (const column of schema.columns) {
			const decorators = []

			if (data && !data[column.field]) {
				continue
			}

			if (column.primary_key) {
				decorators.push(IsOptional())
				continue
			}

			switch (column.type) {
				case DatabaseColumnType.NUMBER:
					decorators.push(IsNumber())
					break
				case DatabaseColumnType.STRING:
					decorators.push(IsString())
					break
				case DatabaseColumnType.BOOLEAN:
					decorators.push(IsBoolean())
					break
				case DatabaseColumnType.DATE:
					decorators.push(IsDateString())
					break
				case DatabaseColumnType.JSON:
					decorators.push(IsJSON())
					break
				default:
					break
			}

			if (!column.required) {
				decorators.push(IsOptional())
			}

			Reflect.decorate(decorators, DynamicClass.prototype, column.field)
		}

		return DynamicClass
	}

	/**
	 * Pipe response from database to class
	 *
	 * This function takes the flat datasource response e.g. { id: 1, name: 'Jon', job.id: '1' job.title: 'Developer' } and pipes it to the classes:
	 * { id: 1, name: 'Jon', job: { id: 1, title: 'Developer' } }
	 *
	 */

	async pipeResponse(
		options: DatabaseFindOneOptions,
		data: { [key: string]: any },
		x_request_id?: string,
	): Promise<object> {
		const nestedObject = {}

		Object.keys(data).forEach(key => {
			const keys = key.split('.')
			keys.reduce((acc, currentKey, index) => {
				if (index === keys.length - 1) {
					acc[currentKey] = data[key]
				} else {
					acc[currentKey] = acc[currentKey] || {}
				}
				return acc[currentKey]
			}, nestedObject)
		})

		//Loop over the nested object and create the class if the key is an object

		const keys = Object.keys(nestedObject)
		for (const key of keys) {
			if (isObject(nestedObject[key])) {
				const relation = options.relations.find(col => col.table === key)
				const DynamicClass = this.schemaToClass(relation.schema, nestedObject[key])
				const instance: object = plainToInstance(DynamicClass, nestedObject[key])
				try {
					const errors = await validate(instance)

					if (errors.length > 0) {
						this.logger.error(
							`${x_request_id ? '[' + x_request_id + ']' : ''}[pipeResponse] ${Object.values(errors[0].constraints).join(', ')}`,
						)
						this.logger.error({
							data,
							instance,
							errors,
						})
						throw new Error(`Error piping response - ${Object.values(errors[0].constraints).join(', ')}`)
					} else {
						nestedObject[key] = instance
					}
				} catch (e) {
					throw new Error(e.message)
				}
			}
		}

		const DynamicClass = this.schemaToClass(options.schema, nestedObject)
		const instance: object = plainToInstance(DynamicClass, nestedObject)
		try {
			const errors = await validate(instance)

			if (errors.length > 0) {
				this.logger.error(
					`${x_request_id ? '[' + x_request_id + ']' : ''}[pipeResponse] ${Object.values(errors[0].constraints).join(', ')}`,
				)
				this.logger.error({
					data,
					instance,
					errors,
				})
				throw new Error(`Error piping response - ${Object.values(errors[0].constraints).join(', ')}`)
			}
		} catch (e) {
			throw new Error(e.message)
		}

		return instance
	}

	/**
	 * validate schema fields with data
	 */

	async validateData(
		schema: DatabaseSchema,
		data: { [key: string]: any },
	): Promise<{ valid: boolean; message?: string; instance?: object }> {
		try {
			const DynamicClass = this.schemaToClass(schema, data)
			const instance: object = plainToInstance(DynamicClass, data)
			const errors = await validate(instance)

			if (errors.length > 0) {
				return {
					valid: false,
					message: errors.map(error => Object.values(error.constraints)).join(', '),
				}
			} else {
				return {
					valid: true,
					instance,
				}
			}
		} catch (e) {
			return {
				valid: false,
				message: e.message,
			}
		}
	}

	async validateFields(options: {
		schema: DatabaseSchema
		fields: string
		x_request_id?: string
	}): Promise<ValidateFieldsResponse> {
		try {
			const validated: string[] = []
			let relations: DatabaseRelations[] = []

			for (const field of options.fields.split(',')) {
				if (field === '') {
					continue
				}

				if (field.includes('.')) {
					relations = await this.convertDeepField({
						field,
						schema: options.schema,
						relations,
						x_request_id: options.x_request_id,
					})
				} else {
					if (this.validateField(options.schema, field)) {
						validated.push(field)
					} else {
						return {
							valid: false,
							message: `Field ${field} not found in table schema for ${options.schema.table}`,
						}
					}
				}
			}

			return {
				valid: true,
				fields: validated,
				relations,
			}
		} catch (e) {
			this.logger.debug(
				`${options.x_request_id ? '[' + options.x_request_id + ']' : ''}[validateFields] ${e.message}`,
			)
			return {
				valid: false,
				message: `Error parsing fields ${options.fields}`,
			}
		}
	}

	validateField(schema: DatabaseSchema, field: string): boolean {
		return schema.columns.find(col => col.field === field) ? true : false
	}

	/**
	 * Validate relations by ensuring that the relation exists in the schema
	 */

	async validateRelations(options: {
		schema: DatabaseSchema
		relation_query: string
		existing_relations: DatabaseRelations[]
		x_request_id?: string
	}): Promise<validateRelationsResponse> {
		try {
			const relations = options.relation_query.split(',')

			for (const relation of relations) {
				if (relation.includes('.')) {
					const relations = await this.convertDeepRelation({
						relation,
						schema: options.schema,
						x_request_id: options.x_request_id,
					})

					for (const rel of relations) {
						if (options.existing_relations.find(relation => relation.table === rel.table)) {
							continue
						}
						options.existing_relations.push(rel)
					}
				} else {
					if (!options.schema.relations.find(col => col.table === relation)) {
						return {
							valid: false,
							message: `Relation ${relation} not found in table schema for ${options.schema.table} `,
						}
					}

					if (options.existing_relations.find(rel => rel.table === relation)) {
						continue
					}

					const relation_schema = await this.getSchema({
						table: relation,
						x_request_id: options.x_request_id,
					})

					options.existing_relations.push({
						table: relation,
						join: {
							...options.schema.relations.find(col => col.table === relation),
							type: DatabaseJoinType.INNER,
						},
						columns: relation_schema.columns.map(col => col.field),
						schema: relation_schema,
					})
				}
			}

			return {
				valid: true,
				relations: options.existing_relations,
			}
		} catch (e) {
			this.logger.debug(
				`${options.x_request_id ? '[' + options.x_request_id + ']' : ''}[validateRelations] ${e.message}`,
			)
			return {
				valid: false,
				message: `Error parsing relations ${options.relation_query}`,
			}
		}
	}

	/**
	 * Validate params for where builder, format is column[operator]=value with operator being from the enum WhereOperator
	 *
	 * Example: ?id[equals]=1&name=John&age[gte]=21
	 */

	async validateWhereParams(options: { schema: DatabaseSchema; params: any }): Promise<validateWhereResponse> {
		const where: DatabaseWhere[] = []

		for (const param in options.params) {
			if (NON_FIELD_PARAMS.includes(param)) continue

			const column = param

			let operator: WhereOperator
			let value: any

			switch (typeof options.params[param]) {
				case 'string':
					operator = WhereOperator.equals
					value = options.params[param]
					break
				case 'object':
					const operators = Object.keys(options.params[param]) as WhereOperator[]
					operator = operators[0]

					if (!operator) {
						operator = WhereOperator.equals
					}
					value = options.params[param][operator]
					operator = WhereOperator[operator]
					break

				default:
					return {
						valid: false,
						message: `Invalid where param ${param}`,
					}
			}

			if (column.includes('.')) {
				continue
			}

			if (!options.schema.columns.find(col => col.field === column)) {
				return {
					valid: false,
					message: `Column ${column} not found in schema`,
				}
			}

			if (!Object.values(WhereOperator).includes(operator)) {
				return {
					valid: false,
					message: `Operator ${operator} not found`,
				}
			}

			const validation = await this.validateData(options.schema, { [column]: value })

			if (!validation.valid) {
				return validation
			}

			where.push({
				column,
				operator,
				value,
			})
		}

		return {
			valid: true,
			where,
		}
	}

	/**
	 * Validate order params, format is sort={column}.{operator},column.{operator},...
	 *
	 * Operator is either `asc` or `desc`
	 *
	 * Example: ?sort=name.asc,id.desc,content.title.asc
	 */

	validateSort(options: { schema: DatabaseSchema; sort: string }): ValidateSortResponse {
		const array = options.sort?.split(',')?.filter(sort => !sort.includes('.'))

		for (const item of array) {
			const direction = item.lastIndexOf('.')

			if (direction === -1) {
				return {
					valid: false,
					message: `Invalid order param ${item}, missing direction, must be either ${item}.asc or ${item}.desc`,
				}
			}

			const operator = item.substring(direction)

			if (operator !== 'asc' && operator !== 'desc') {
				return {
					valid: false,
					message: `Invalid order operator ${operator}, must be either asc or desc`,
				}
			}

			const column = item.substring(0, direction)

			if (!options.schema.columns.find(col => col.field === column)) {
				return {
					valid: false,
					message: `Column ${column} not found in schema`,
				}
			}
		}

		return {
			valid: true,
			sort: this.createSortArray(options.sort),
		}
	}

	/**
	 * Convert where into where and relations
	 */

	async convertDeepWhere(options: {
		where: DatabaseWhere
		schema: DatabaseSchema
		x_request_id?: string
	}): Promise<DatabaseRelations[]> {
		const relations: DatabaseRelations[] = []

		//deconstruct the column to create the relations of each table in the items object
		let items = options.where.column.split('.')

		for (let i = 0; i < items.length - 1; i++) {
			if (!options.schema.relations.find(col => col.table === items[i])) {
				this.logger.error(
					`${options.x_request_id ? '[' + options.x_request_id + ']' : ''}Relation ${items[i]} not found in schema for ${options.schema.table}`,
				)
				throw new Error(`Relation ${items[i]} not found in schema for ${options.schema.table}`)
			}

			const relation_schema = await this.getSchema({ table: items[i], x_request_id: options.x_request_id })

			const relation = {
				table: items[i],
				join: {
					...options.schema.relations.find(col => col.table === items[i]),
					type: DatabaseJoinType.INNER,
				},
				where: i === items.length - 2 ? options.where : undefined,
				schema: relation_schema,
			}

			relations.push(relation)

			options.schema = relation_schema
		}

		return relations
	}

	/**
	 * Convert where into where and relations
	 */

	async convertDeepField(options: {
		field: string
		schema: DatabaseSchema
		relations: DatabaseRelations[]
		x_request_id?: string
	}): Promise<DatabaseRelations[]> {
		//deconstruct the column to create the relations of each table in the items object
		let items = options.field.split('.')

		for (let i = 0; i < items.length - 1; i++) {
			if (!options.schema.relations.find(col => col.table === items[i])) {
				this.logger.error(
					`${options.x_request_id ? '[' + options.x_request_id + ']' : ''}Relation ${items[i]} not found in schema for ${options.schema.table}`,
				)
				throw new Error(`Relation ${items[i]} not found in schema for ${options.schema.table}`)
			}

			const relation_schema = await this.getSchema({ table: items[i], x_request_id: options.x_request_id })

			if (options.relations.find(rel => rel.table === items[i])) {
				const index = options.relations.findIndex(rel => rel.table === items[i])
				if (i === items.length - 2) {
					options.relations[index].columns.push(items[items.length - 1])
				}
			} else {
				options.relations.push({
					table: items[i],
					join: {
						...options.schema.relations.find(col => col.table === items[i]),
						type: DatabaseJoinType.INNER,
					},
					columns: i === items.length - 2 ? [items[items.length - 1]] : undefined,
					schema: relation_schema,
				})
			}

			options.schema = relation_schema
		}

		return options.relations
	}

	/**
	 * Convert relation into relations
	 */

	async convertDeepRelation(options: {
		relation: string
		schema: DatabaseSchema
		x_request_id?: string
	}): Promise<DatabaseRelations[]> {
		const relations: DatabaseRelations[] = []

		//deconstruct the column to create the relations of each table in the items object
		let items = options.relation.split('.')

		for (let i = 0; i < items.length - 1; i++) {
			if (!options.schema.relations.find(col => col.table === items[i])) {
				this.logger.error(
					`${options.x_request_id ? '[' + options.x_request_id + ']' : ''}Relation ${items[i]} not found in schema for ${options.schema.table}`,
				)
				throw new Error(`Relation ${items[i]} not found in schema for ${options.schema.table}`)
			}

			const relation_schema = await this.getSchema({ table: items[i], x_request_id: options.x_request_id })

			relations.push({
				table: items[i],
				join: {
					...options.schema.relations.find(col => col.table === items[i]),
					type: DatabaseJoinType.INNER,
				},
				columns: i === items.length - 1 ? [items[items.length]] : undefined,
				schema: relation_schema,
			})

			options.schema = relation_schema
		}

		return relations
	}

	/**
	 * Takes the sort query parameter and returns the sort object
	 */

	createSortArray(sort: string): SortCondition[] {
		if (!sort) return []

		const array = sort.split(',')
		const sortArray = []

		for (const item of array) {
			const direction = item.lastIndexOf('.')
			const column = item.substring(0, direction)
			const operator = item.substring(direction + 1)
			sortArray.push({ column, operator: operator.toUpperCase() })
		}

		return sortArray
	}
}
