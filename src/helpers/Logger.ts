import { ConsoleLogger, Injectable, LogLevel } from '@nestjs/common'

import { Env } from '../utils/Env'
import { Environment } from '../utils/Env.types'

@Injectable()
export class Logger extends ConsoleLogger {
	constructor() {
		super('Llana')
	}

	error(message: any, ...optionalParams: [...any, string?]): void {
		if (logLevel().includes('error')) {
			super.error(message, ...optionalParams)
		}
	}

	warn(message: any, ...optionalParams: [...any, string?]): void {
		if (logLevel().includes('warn')) {
			super.warn(message, ...optionalParams)
		}
	}

	log(message: any, ...optionalParams: [...any, string?]): void {
		if (logLevel().includes('log')) {
			super.log(message, ...optionalParams)
		}
	}

	debug(message: any, ...optionalParams: [...any, string?]): void {
		if (logLevel().includes('debug')) {
			super.debug(message, ...optionalParams)
		}
	}

	verbose(message: any, ...optionalParams: [...any, string?]): void {
		if (logLevel().includes('verbose')) {
			super.verbose(message, ...optionalParams)
		}
	}

	status(): void {
		this.log(`--------- Logging Status ---------`)
		this.error(`This is an error`)
		this.warn(`This is a warning`)
		this.log(`This is a log`)
		this.debug(`This is a debug`)
		this.verbose(`This is a verbose`)
		this.log(`------- Logging Status End -------`)
	}

	table(data: any): void {
		console.table(data)
	}
}

export function logLevel(): LogLevel[] {
	let logLevels: LogLevel[] = ['error', 'warn']

	switch (Env.get()) {
		case Environment.production:
			logLevels = <LogLevel[]>process.env.LOG_LEVELS_PROD?.split(',') ?? ['error', 'warn', 'log']
			break
		case Environment.sandbox:
			logLevels = <LogLevel[]>process.env.LOG_LEVELS_SANDBOX?.split(',') ?? ['error', 'warn', 'log', 'debug']
			break
		case Environment.test:
			logLevels = <LogLevel[]>process.env.LOG_LEVELS_TEST?.split(',') ?? ['error', 'warn', 'log']
			break
		case Environment.development:
			logLevels = <LogLevel[]>process.env.LOG_LEVELS_DEV?.split(',') ?? [
				'error',
				'warn',
				'log',
				'debug',
				'verbose',
			]
			break
	}

	return logLevels
}
