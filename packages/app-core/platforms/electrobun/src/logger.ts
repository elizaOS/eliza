type LogMethod = (...args: unknown[]) => void;

function bindConsoleMethod(method: "debug" | "error" | "info" | "log" | "warn"): LogMethod {
	return (...args: unknown[]) => {
		console[method](...args);
	};
}

export const logger: {
	debug: LogMethod;
	error: LogMethod;
	info: LogMethod;
	success: LogMethod;
	warn: LogMethod;
} = {
	debug: bindConsoleMethod("debug"),
	error: bindConsoleMethod("error"),
	info: bindConsoleMethod("log"),
	success: bindConsoleMethod("log"),
	warn: bindConsoleMethod("warn"),
};
