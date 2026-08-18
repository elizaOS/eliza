/**
 * ACP-specific process prelude. JSON-RPC owns stdout, so suppress the runtime's
 * informational console logger before @elizaos/core is evaluated; errors still
 * use the entrypoint's explicit stderr logger. Capture executable authority at
 * the same first-import boundary used by the interactive CLI.
 */
import { captureHostExecutionBaseline } from "@elizaos/shared/host-execution-env";

process.env.LOG_LEVEL ??= "fatal";
// Some plugins still use console.info/log directly during startup. Redirect
// every non-error console method before those modules load; stdout must contain
// only ACP NDJSON or a strict client will lose framing.
for (const method of ["log", "info", "warn", "debug"] as const) {
  console[method] = console.error.bind(console);
}
captureHostExecutionBaseline();
