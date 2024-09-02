import { registerAs } from '@nestjs/config'

/**
 * If you would like to globally lock down your API to specific hosts, you can add them here.
 */

export default registerAs('hosts', () => ['localhost:3030'])
