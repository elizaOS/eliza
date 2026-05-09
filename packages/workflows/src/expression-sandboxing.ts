// Stub: original implementation depended on @workflows/tournament for AST visiting
// to sandbox expression evaluation. This package ships only the type contracts
// and helpers, so the AST hooks are replaced with no-ops. Consumers that need
// real expression sandboxing must override these symbols.

export const sanitizerName = '__sanitize';
export const DOLLAR_SIGN_ERROR = 'Cannot access "$" without calling it as a function';

type AstHook = (ast: unknown, dataNode: unknown) => unknown;

export const ThisSanitizer: AstHook = (ast) => ast;
export const DollarSignValidator: AstHook = (ast) => ast;
export const PrototypeSanitizer: AstHook = (ast) => ast;

export const sanitizer = (value: unknown): unknown => value;
