/**
 * Pauses a real Git pre-commit process at a deterministic race boundary.
 * The test exposes this module through NODE_OPTIONS on a Node-binary hook
 * symlink because generated shebang executables deadlock under Bun on macOS.
 */

if (process.argv.length === 1) {
  if (process.env.ACP_TEST_ROLE === "A") {
    const { closeSync, openSync } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");
    closeSync(openSync(process.env.ACP_TEST_SIGNAL_FILE, "w"));
    execFileSync("sleep", [process.env.ACP_TEST_SLEEP_SECONDS]);
  }
  process.exit(0);
}
