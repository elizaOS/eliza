/**
 * Holds the exact restore container open for private one-shot materializers.
 * The provider invokes this dependency-free entrypoint through env -i instead
 * of the image's ordinary startup script. It never reads workload state,
 * imports the Agent runtime, opens listeners or accepts a command to boot.
 * Container start/restart therefore cannot promote a candidate implicitly.
 */

import process from "node:process";

// This entrypoint is only the container's PID 1, not a reusable host service.
// Requiring an empty environment also rejects accidental unsanitized invocation;
// the provider must clear NODE_OPTIONS before Node itself is executed.
if (
  process.platform !== "linux" ||
  process.pid !== 1 ||
  process.argv.length !== 2 ||
  Object.keys(process.env).length !== 0
) {
  process.exitCode = 64;
} else {
  process.umask(0o077);
  const keepAlive = setInterval(() => {}, 30_000);
  const stop = () => {
    clearInterval(keepAlive);
    process.stdin.destroy();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
