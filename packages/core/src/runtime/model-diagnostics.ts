/** Controls construction of debug-only model diagnostics across shared runtime targets. */

// Whether debug-level logs are emitted, captured once at load (mirrors the
// logger's static LOG_LEVEL read; debug is on only for trace/verbose/debug).
// Lets hot paths skip building expensive debug-only payloads.
export const RUNTIME_DEBUG_LOG_ENABLED = ["trace", "verbose", "debug"].includes(
	String(process.env.LOG_LEVEL || "info").toLowerCase(),
);
