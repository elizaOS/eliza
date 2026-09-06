/** Controls construction of debug-only model diagnostics across shared runtime targets. */

// Whether debug-level logs are emitted, captured once at load (mirrors the
// logger's static LOG_LEVEL read; debug is on only for trace/verbose/debug).
// Lets hot paths skip building expensive debug-only payloads. Guarded for the
// browser/edge build targets where `process` is absent.
export const RUNTIME_DEBUG_LOG_ENABLED =
	typeof process !== "undefined" &&
	["trace", "verbose", "debug"].includes(
		String(process.env?.LOG_LEVEL || "info").toLowerCase(),
	);
