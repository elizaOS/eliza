// Stub: the original implementation depended on @workflows/tournament for AST-based
// expression sandboxing. This package ships only the type contracts and helpers,
// so the runtime evaluator is replaced with a no-op. Consumers that need to
// actually evaluate workflow expressions must override these symbols.

type Evaluator = (expr: string, data: unknown) => string | null | (() => unknown);
type ErrorHandler = (error: Error) => void;

let errorHandler: ErrorHandler = () => {};

export const setErrorHandler = (handler: ErrorHandler) => {
	errorHandler = handler;
};

export const evaluateExpression: Evaluator = (_expr, _data) => {
	const error = new Error('expression evaluation runtime is not bundled in @elizaos/workflows');
	errorHandler(error);
	throw error;
};
