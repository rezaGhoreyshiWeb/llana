import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as sql from 'mssql'

import {
	DeleteResponseObject,
	FindManyResponseObject,
	FindOneResponseObject,
	IsUniqueResponse,
} from '../dtos/response.dto'
import { deconstructConnectionString, getDatabaseName } from '../helpers/Database'
import { Logger } from '../helpers/Logger'
import { Pagination } from '../helpers/Pagination'
import {
	DatabaseColumnType,
	DatabaseCreateOneOptions,
	DatabaseDeleteOneOptions,
	DatabaseFindManyOptions,
	DatabaseFindOneOptions,
	DatabaseFindTotalRecords,
	DatabaseSchema,
	DatabaseSchemaColumn,
	DatabaseSchemaRelation,
	DatabaseType,
	DatabaseUniqueCheckOptions,
	DatabaseUpdateOneOptions,
	WhereOperator,
} from '../types/database.types'
import { MSSQLColumnType } from '../types/databases/mssql.types'
import { SortCondition } from '../types/schema.types'
import { replaceQ } from '../utils/String'

const DATABASE_TYPE = DatabaseType.MSSQL
const RESERVED_WORDS = ['USER', 'TABLE']

@Injectable()
export class MSSQL {
	constructor(
		private readonly configService: ConfigService,
		private readonly logger: Logger,
		private readonly pagination: Pagination,
	) {}

	reserveWordFix(word: string): string {
		if (RESERVED_WORDS.includes(word.toUpperCase())) {
			return `[${word}]`
		}
		return word
	}

	async createConnection(): Promise<sql.ConnectionPool> {
		try {
			if (!sql) {
				throw new Error(`${DATABASE_TYPE} library is not initialized`)
			}

			const deconstruct = deconstructConnectionString(this.configService.get('database.host'))
			let connectionString = `Server=${deconstruct.host},${deconstruct.port};Database=${deconstruct.database};User Id=${deconstruct.username};Password=${deconstruct.password};`

			if (this.configService.get('AZURE')) {
				connectionString += 'Encrypt=true'
			}

			connectionString += ' TrustServerCertificate=true'

			return await sql.connect(connectionString)
		} catch (e) {
			this.logger.error(`[${DATABASE_TYPE}] Error creating database connection - ${e.message}`)
			throw new Error('Error creating database connection')
		}
	}

	async checkConnection(options: { x_request_id?: string }): Promise<boolean> {
		try {
			await this.createConnection()
			return true
		} catch (e) {
			this.logger.error(
				`[${DATABASE_TYPE}] Error checking database connection - ${e.message} ${options.x_request_id ?? ''}`,
			)
			return false
		}
	}

	async performQuery(options: { sql: string; values?: any[]; x_request_id?: string }): Promise<sql.IResult<any>> {
		const connection = await this.createConnection()

		try {
			this.logger.debug(
				`[${DATABASE_TYPE}] ${replaceQ(options.sql, options.values)} ${options.x_request_id ?? ''}`,
			)

			if (options.values || options.values?.length) {
				options.sql = replaceQ(options.sql, options.values)
			}

			const result = await connection.query(options.sql)
			this.logger.debug(`[${DATABASE_TYPE}] Results: ${JSON.stringify(result)} - ${options.x_request_id ?? ''}`)
			connection.close()
			return result
		} catch (e) {
			this.logger.warn(`[${DATABASE_TYPE}] Error executing query`)
			this.logger.warn({
				x_request_id: options.x_request_id,
				sql: replaceQ(options.sql, options.values),
				error: {
					message: e.message,
				},
			})
			connection.close()
			throw new Error(e)
		}
	}

	/**
	 * List all tables in the database
	 */

	async listTables(options: { x_request_id?: string }): Promise<string[]> {
		try {
			const databaseName = getDatabaseName(this.configService.get('database.host'))
			const query = `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_CATALOG = '${databaseName}'`
			const results = (await this.performQuery({ sql: query, x_request_id: options.x_request_id })).recordset
			const tables = results.map(row => Object.values(row)[0]) as string[]
			this.logger.debug(`[${DATABASE_TYPE}] Tables: ${tables} ${options.x_request_id ?? ''}`)
			return tables
		} catch (e) {
			this.logger.error(`[${DATABASE_TYPE}] Error listing tables ${options.x_request_id ?? ''}`)
			throw new Error(e)
		}
	}

	/**
	 * Get Table Schema
	 * @param repository
	 * @param table_name
	 */

	async getSchema(options: { table: string; x_request_id?: string }): Promise<DatabaseSchema> {
		//get schema for MSSQL database

		const query = `SELECT COLUMN_NAME as 'field', DATA_TYPE as 'type', IS_NULLABLE as 'nullable', COLUMN_DEFAULT as 'default' FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${options.table}';`

		let columns_result = <any>(
			await this.performQuery({
				sql: query,
				x_request_id: options.x_request_id,
			})
		).recordset

		if (!columns_result?.length) {
			throw new Error(`Table ${options.table} does not exist ${options.x_request_id ?? ''}`)
		}

		const constraints_query = `SELECT CONSTRAINT_TYPE as type, COLUMN_NAME as field from INFORMATION_SCHEMA.TABLE_CONSTRAINTS Tab, INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE Col WHERE Col.Constraint_Name = Tab.Constraint_Name AND Col.Table_Name = Tab.Table_Name AND Col.Table_Name = '${options.table}';`

		const constraints_result = (
			await this.performQuery({
				sql: constraints_query,
				x_request_id: options.x_request_id,
			})
		).recordset

		const columns = columns_result.map((column: any) => {
			return <DatabaseSchemaColumn>{
				field: column.field,
				type: this.fieldMapper(column.type),
				required: column.nullable === 'NO',
				nullable: column.nullable === 'YES',
				primary_key: constraints_result.find((c: any) => c.type === 'PRIMARY KEY' && c.field === column.field)
					? true
					: false,
				foreign_key:
					column.key ===
					constraints_result.find((c: any) => c.type === 'FOREIGN KEY' && c.field === column.field)
						? true
						: false,
				default: column.default,
			}
		})

		const relations: DatabaseSchemaRelation[] = []

		const relation_query = `select tab.name as [table],
			col.name as [column],
			pk_tab.name as org_table,
			pk_col.name as org_column
		from sys.tables tab
			inner join sys.columns col 
				on col.object_id = tab.object_id
			left outer join sys.foreign_key_columns fk_cols
				on fk_cols.parent_object_id = tab.object_id
				and fk_cols.parent_column_id = col.column_id
			left outer join sys.foreign_keys fk
				on fk.object_id = fk_cols.constraint_object_id
			left outer join sys.tables pk_tab
				on pk_tab.object_id = fk_cols.referenced_object_id
			left outer join sys.columns pk_col
				on pk_col.column_id = fk_cols.referenced_column_id
				and pk_col.object_id = fk_cols.referenced_object_id
		where tab.name = '${options.table}' AND fk_cols.constraint_column_id = 1;`

		const relation_result = (
			await this.performQuery({
				sql: relation_query,
				x_request_id: options.x_request_id,
			})
		).recordset

		for (const r of relation_result) {
			const relation: DatabaseSchemaRelation = {
				table: r.table,
				column: r.column,
				org_table: r.org_table,
				org_column: r.org_column,
			}

			relations.push(relation)

			const relation_back: DatabaseSchemaRelation = {
				table: r.org_table,
				column: r.org_column,
				org_table: r.table,
				org_column: r.column,
			}

			relations.push(relation_back)
		}

		return {
			table: options.table,
			columns,
			primary_key: columns.find(column => column.primary_key)?.field,
			relations,
		}
	}

	/**
	 * Insert a record
	 */

	async createOne(options: DatabaseCreateOneOptions, x_request_id?: string): Promise<FindOneResponseObject> {
		const table_name = options.schema.table
		const values: any[] = []

		options = this.pipeObjectToMSSQL(options) as DatabaseCreateOneOptions

		const columns = Object.keys(options.data)
		const dataValues = Object.values(options.data)

		values.push(...dataValues)

		if (values.length) {
			for (const v in values) {
				if (typeof values[v] === 'string') {
					values[v] = values[v].replace(/'/g, "''")
				}
			}
		}

		for (const c in columns) {
			columns[c] = this.reserveWordFix(columns[c])
		}

		const command = `INSERT INTO ${this.reserveWordFix(table_name)} (${columns.join(', ')}) VALUES ( '?'${values.map(() => ``).join(`, '?'`)} ); SELECT SCOPE_IDENTITY() AS insertId;`

		const result = <{ insertId: number }>(
			(<any>(await this.performQuery({ sql: command, values, x_request_id })).recordset[0])
		)

		return await this.findOne(
			{
				schema: options.schema,
				where: [
					{
						column: options.schema.primary_key,
						operator: WhereOperator.equals,
						value: result.insertId,
					},
				],
			},
			x_request_id,
		)
	}

	/**
	 * Find single record
	 */

	async findOne(options: DatabaseFindOneOptions, x_request_id: string): Promise<FindOneResponseObject | undefined> {
		let [command, values] = this.find(options)

		const results = (await this.performQuery({ sql: command, values, x_request_id })).recordset
		if (!results[0]) {
			return
		}

		return this.formatOutput(options, results[0])
	}

	/**
	 * Find multiple records
	 */

	async findMany(options: DatabaseFindManyOptions, x_request_id: string): Promise<FindManyResponseObject> {
		if (!options.sort?.length) {
			if (options.schema.primary_key) {
				options.sort = [
					{
						column: options.schema.primary_key,
						operator: 'ASC',
					},
				]
			} else {
				options.sort = [
					{
						column: options.schema.columns[0].field,
						operator: 'ASC',
					},
				]
			}
		}

		if (!options.limit) {
			options.limit = this.configService.get<number>('database.defaults.limit') ?? 20
		}

		if (!options.offset) {
			options.offset = 0
		}

		const total = await this.findTotalRecords(options, x_request_id)

		let results: any[] = []

		if (total > 0) {
			let [command, values] = this.find(options)
			results = (await this.performQuery({ sql: command, values, x_request_id })).recordset
			for (const r in results) {
				results[r] = this.formatOutput(options, results[r])
			}
		}

		return {
			limit: options.limit,
			offset: options.offset,
			total,
			pagination: {
				total: results.length,
				page: {
					current: this.pagination.current(options.limit, options.offset),
					prev: this.pagination.previous(options.limit, options.offset),
					next: this.pagination.next(options.limit, options.offset, total),
					first: this.pagination.first(options.limit),
					last: this.pagination.last(options.limit, total),
				},
			},
			data: results,
		}
	}

	/**
	 * Get total records with where conditions
	 */

	async findTotalRecords(options: DatabaseFindTotalRecords, x_request_id: string): Promise<number> {
		let [command, values] = this.find(options, true)
		const results = (await this.performQuery({ sql: command, values, x_request_id })).recordset
		return Number(results[0].total)
	}

	/**
	 * Update one records
	 */

	async updateOne(options: DatabaseUpdateOneOptions, x_request_id: string): Promise<FindOneResponseObject> {
		const table_name = options.schema.table

		if (options.data[options.schema.primary_key]) {
			delete options.data[options.schema.primary_key]
		}

		const values = [...Object.values(options.data), options.id.toString()]
		let command = `UPDATE ${this.reserveWordFix(table_name)} SET `

		options = this.pipeObjectToMSSQL(options) as DatabaseUpdateOneOptions

		command += `${Object.keys(options.data)
			.map(key => `${key} = '?'`)
			.join(', ')} `

		command += `WHERE ${options.schema.primary_key} = ?`

		if (values.length) {
			for (const v in values) {
				if (typeof values[v] === 'string') {
					values[v] = values[v].replace(/'/g, "''")
				}
			}
		}

		await this.performQuery({ sql: command, values, x_request_id })

		return await this.findOne(
			{
				schema: options.schema,
				where: [
					{
						column: options.schema.primary_key,
						operator: WhereOperator.equals,
						value: options.id,
					},
				],
			},
			x_request_id,
		)
	}

	/**
	 * Delete single record
	 */

	async deleteOne(options: DatabaseDeleteOneOptions, x_request_id: string): Promise<DeleteResponseObject> {
		if (options.softDelete) {
			const result = await this.updateOne(
				{
					id: options.id,
					schema: options.schema,
					data: {
						[options.softDelete]: new Date().toISOString().slice(0, 19).replace('T', ' '),
					},
				},
				x_request_id,
			)

			if (result) {
				return {
					deleted: 1,
				}
			}
		}

		const table_name = options.schema.table

		const values = [options.id]
		let command = `DELETE FROM ${this.reserveWordFix(table_name)} `

		command += `WHERE ${options.schema.primary_key} = ?`

		const result = await this.performQuery({ sql: command, values, x_request_id })

		return {
			deleted: result.rowsAffected.length,
		}
	}

	async uniqueCheck(options: DatabaseUniqueCheckOptions, x_request_id: string): Promise<IsUniqueResponse> {
		for (const column of options.schema.columns) {
			if (column.unique_key) {
				const command = `SELECT COUNT(*) as total FROM ${this.reserveWordFix(options.schema.table)} WHERE ${column.field} = ?`
				const result = await this.performQuery({
					sql: command,
					values: [options.data[column.field]],
					x_request_id,
				})

				if (result[0].total > 0) {
					return {
						valid: false,
						message: `Record with ${column.field} ${options.data[column.field]} already exists`,
					}
				}
			}
		}

		return {
			valid: true,
		}
	}

	/**
	 * Create table from schema object
	 */

	async createTable(schema: DatabaseSchema): Promise<boolean> {
		try {
			const columns = schema.columns.map(column => {
				let column_string = `${this.reserveWordFix(column.field)} ${this.fieldMapperReverse(column.type)}`

				if (column.type === DatabaseColumnType.STRING || column.type === DatabaseColumnType.ENUM) {
					column_string += `(${column.extra?.length ?? 255})`
				}

				if (column.required) {
					column_string += ' NOT NULL'
				}

				if (column.primary_key) {
					column_string += ' IDENTITY'
				}

				if (column.default) {
					if (column.type === DatabaseColumnType.BOOLEAN) {
						column_string += ` DEFAULT ${column.default === true ? 1 : 0}`
					} else {
						column_string += ` DEFAULT ${column.default}`
					}
				}

				return column_string
			})

			let command = `CREATE TABLE ${this.reserveWordFix(schema.table)} (${columns.join(', ')}`

			if (schema.primary_key) {
				command += `, PRIMARY KEY (${this.reserveWordFix(schema.primary_key)})`
			}

			command += ');'

			await this.performQuery({ sql: command })

			if (schema.relations?.length) {
				for (const relation of schema.relations) {
					const command = `ALTER TABLE ${this.reserveWordFix(schema.table)} ADD FOREIGN KEY (${relation.column}) REFERENCES ${this.reserveWordFix(relation.org_table)}(${relation.org_column})`
					await this.performQuery({ sql: command })
				}
			}

			return true
		} catch (e) {
			this.logger.error(`[${DATABASE_TYPE}][createTable] Error creating table ${schema.table}`, { e })
			return false
		}
	}

	private find(
		options: DatabaseFindOneOptions | DatabaseFindManyOptions,
		count: boolean = false,
	): [string, string[]] {
		const table_name = options.schema.table
		let values: any[] = []

		let command

		if (count) {
			command = `SELECT COUNT(*) as total `
		} else {
			command = `SELECT `

			if (options.fields?.length) {
				for (const f in options.fields) {
					command += ` ${this.reserveWordFix(options.schema.table)}.${options.fields[f]} as ${options.fields[f]},`
				}
				command = command.slice(0, -1)
			} else {
				command += ` ${this.reserveWordFix(options.schema.table)}.* `
			}

			if (options.relations?.length) {
				for (const r in options.relations) {
					if (options.relations[r].columns?.length) {
						for (const c in options.relations[r].columns) {
							command += `, ${this.reserveWordFix(options.relations[r].table)}.${options.relations[r].columns[c]} as ${this.reserveWordFix(options.relations[r].table)}.${options.relations[r].columns[c]} `
						}
					}
				}
			}
		}

		command += ` FROM ${this.reserveWordFix(table_name)} `

		if (options.relations?.length) {
			for (const relation of options.relations) {
				command += `${relation.join.type ?? 'INNER JOIN'} ${this.reserveWordFix(relation.join.table)} ON ${this.reserveWordFix(relation.join.org_table)}.${this.reserveWordFix(relation.join.org_column)} = ${this.reserveWordFix(relation.join.table)}.${this.reserveWordFix(relation.join.column)} `
			}
		}

		if (options.where?.length) {
			command += `WHERE `

			for (const w in options.where) {
				if (options.where[w].operator === WhereOperator.search) {
					options.where[w].value = '%' + options.where[w].value + '%'
				}
			}

			command += `${options.where.map(w => `${w.column.includes('.') ? w.column : this.reserveWordFix(table_name) + '.' + this.reserveWordFix(w.column)} ${w.operator === WhereOperator.search ? 'LIKE' : w.operator} ${w.operator !== WhereOperator.not_null && w.operator !== WhereOperator.null ? `'?'` : ''}  `).join(' AND ')} `
			const where_values = options.where.map(w => w.value)
			if (where_values.length) {
				for (const w in where_values) {
					if (where_values[w] === undefined) {
						continue
					}
					values.push(where_values[w])
				}
			}
		}

		for (const r in options.relations) {
			if (options.relations[r].where) {
				const items = options.relations[r].where.column.split('.')

				switch (items.length) {
					case 1:
						command += `AND \`${this.reserveWordFix(options.relations[r].table)}\`.\`${this.reserveWordFix(options.relations[r].where.column)}\` ${options.relations[r].where.operator} ? `
						break
					case 2:
						command += `AND \`${items[0]}\`.\`${items[1]}\` ${options.relations[r].where.operator} ? `
						break
					default:
						command += `AND \`${items[items.length - 2]}\`.\`${items[items.length - 1]}\` ${options.relations[r].where.operator} ? `
						break
				}

				if (options.relations[r].where.value) {
					values.push(options.relations[r].where.value)
				}
			}
		}

		if (!count) {
			let sort: SortCondition[] = []

			if ((options as DatabaseFindManyOptions).sort) {
				sort = (options as DatabaseFindManyOptions).sort?.filter(sort => !sort.column.includes('.'))
			}

			if (sort?.length) {
				command += ` ORDER BY ${sort.map(sort => `${sort.column} ${sort.operator}`).join(', ')} `
			}

			if ((options as DatabaseFindManyOptions).offset || (options as DatabaseFindManyOptions).limit) {
				command += ` OFFSET ${(options as DatabaseFindManyOptions).offset} ROWS `
			}

			if ((options as DatabaseFindManyOptions).limit) {
				let row = 'ROW ONLY'

				if ((options as DatabaseFindManyOptions).limit > 1) {
					row = 'ROWS ONLY'
				}

				command += `FETCH NEXT ${(options as DatabaseFindManyOptions).limit} ${row} `
			}
		}

		command += `;`

		return [command.trim(), values]
	}

	private fieldMapper(type: MSSQLColumnType): DatabaseColumnType {
		if (type.includes('decimal') || type.includes('numeric') || type.includes('float')) {
			return DatabaseColumnType.NUMBER
		}

		if (
			type.includes('char') ||
			type.includes('varchar') ||
			type.includes('nvarchar') ||
			type.includes('binary') ||
			type.includes('varbinary')
		) {
			return DatabaseColumnType.STRING
		}

		switch (type) {
			case MSSQLColumnType.INT:
			case MSSQLColumnType.TINYINT:
			case MSSQLColumnType.SMALLINT:
			case MSSQLColumnType.BIGINT:
			case MSSQLColumnType.FLOAT:
			case MSSQLColumnType.DECIMAL:
			case MSSQLColumnType.NUMERIC:
			case MSSQLColumnType.REAL:
			case MSSQLColumnType.TIMESTAMP:
			case MSSQLColumnType.BIT:
				return DatabaseColumnType.NUMBER
			case MSSQLColumnType.CHAR:
			case MSSQLColumnType.VARCHAR:
			case MSSQLColumnType.TEXT:
			case MSSQLColumnType.NTEXT:
			case MSSQLColumnType.NCHAR:
			case MSSQLColumnType.NVARCHAR:
				return DatabaseColumnType.STRING
			case MSSQLColumnType.DATE:
			case MSSQLColumnType.DATETIME:
			case MSSQLColumnType.DATETIME2:
			case MSSQLColumnType.SMALLDATETIME:
			case MSSQLColumnType.DATETIMEOFFSET:
			case MSSQLColumnType.TIME:
				return DatabaseColumnType.DATE
			case MSSQLColumnType.SQL_VARIANT:
			case MSSQLColumnType.UNIQUEIDENTIFIER:
			case MSSQLColumnType.TABLE:
			case MSSQLColumnType.XML:
			default:
				return DatabaseColumnType.UNKNOWN
		}
	}

	private fieldMapperReverse(type: DatabaseColumnType): MSSQLColumnType {
		switch (type) {
			case DatabaseColumnType.STRING:
				return MSSQLColumnType.VARCHAR
			case DatabaseColumnType.NUMBER:
				return MSSQLColumnType.INT
			case DatabaseColumnType.BOOLEAN:
				return MSSQLColumnType.BIT
			case DatabaseColumnType.DATE:
				return MSSQLColumnType.DATETIME
			default:
				return MSSQLColumnType.VARCHAR
		}
	}

	private pipeObjectToMSSQL(
		options: DatabaseCreateOneOptions | DatabaseUpdateOneOptions,
	): DatabaseCreateOneOptions | DatabaseUpdateOneOptions {
		for (const column of options.schema.columns) {
			if (!options.data[column.field]) {
				continue
			}

			switch (column.type) {
				case DatabaseColumnType.BOOLEAN:
					if (options.data[column.field] === true) {
						options.data[column.field] = 1
					} else if (options.data[column.field] === false) {
						options.data[column.field] = 0
					}
					break
				case DatabaseColumnType.DATE:
					if (options.data[column.field]) {
						options.data[column.field] = new Date(options.data[column.field])
							.toISOString()
							.slice(0, 19)
							.replace('T', ' ')
					}
					break

				default:
					continue
			}
		}

		return options
	}

	private formatOutput(options: DatabaseFindOneOptions, data: { [key: string]: any }): object {
		for (const key in data) {
			if (key.includes('.')) {
				const [table, field] = key.split('.')
				const relation = options.relations.find(r => r.table === table)
				data[key] = this.formatField(relation.schema.columns.find(c => c.field === field).type, data[key])
			} else {
				const column = options.schema.columns.find(c => c.field === key)
				data[key] = this.formatField(column.type, data[key])
			}
		}

		return data
	}

	/**
	 *
	 */

	private formatField(type: DatabaseColumnType, value: any): any {
		if (value === null) {
			return null
		}

		switch (type) {
			case DatabaseColumnType.BOOLEAN:
				return value === 1
			case DatabaseColumnType.DATE:
				return new Date(value).toISOString()
			default:
				return value
		}
	}

	async truncate(table: string): Promise<void> {
		await this.performQuery({ sql: 'TRUNCATE TABLE [' + table + ']' })
	}
}
