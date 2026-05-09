// Stub: p1p3s does not ship a separate expression sandbox runtime. Consumers
// that need expression evaluation must provide it explicitly.

type Evaluator = (expr: string, data: unknown) => string | null | (() => unknown);
type ErrorHandler = (error: Error) => void;

let errorHandler: ErrorHandler = () => {};

export const setErrorHandler = (handler: ErrorHandler) => {
	errorHandler = handler;
};

export const evaluateExpression: Evaluator = (_expr, _data) => {
	const error = new Error('expression evaluation runtime is not bundled in @elizaos/p1p3s');
	errorHandler(error);
	throw error;
};
