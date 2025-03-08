import chalk from "chalk";

/**
 * Logger object with various logging methods.
 * @type {Object}
 * @property {Function} error - Logs an error message in red color.
 * @property {Function} warn - Logs a warning message in yellow color.
 * @property {Function} info - Logs an info message in cyan color.
 * @property {Function} success - Logs a success message in green color.
 * @property {Function} break - Logs an empty line.
 */
export const logger = {
	error(...args: unknown[]) {
		console.log(chalk.red(...args));
	},
	warn(...args: unknown[]) {
		console.log(chalk.yellow(...args));
	},
	info(...args: unknown[]) {
		console.log(chalk.cyan(...args));
	},
	success(...args: unknown[]) {
		console.log(chalk.green(...args));
	},
	break() {
		console.log("");
	},
};
