import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

/** Service readiness only: this does not qualify provider bytes or features. */
export function androidWebViewReady(state) {
  const current = state.match(
    /^\s*Current WebView package \(name, version\): \(([A-Za-z][A-Za-z0-9_.]+), ([^\r\n)]+)\)\s*$/m,
  );
  if (!current) return false;
  const started = state.match(/^\s*Number of relros started: (\d+)\s*$/m);
  const finished = state.match(/^\s*Number of relros finished: (\d+)\s*$/m);
  const provider = current[1].replaceAll(".", "\\.");
  return (
    /^\s*WebView package dirty: false\s*$/m.test(state) &&
    /^\s*Any WebView package installed: true\s*$/m.test(state) &&
    new RegExp(
      `^\\s*Valid package ${provider} \\(versionName: [^\\r\\n]+\\) is\\s+installed/enabled for all users\\s*$`,
      "m",
    ).test(state) &&
    started !== null &&
    finished !== null &&
    Number(started[1]) > 0 &&
    Number(started[1]) === Number(finished[1])
  );
}

/** Read-only admission after switching users. Never retries instrumentation. */
export async function waitForAndroidWebView({
  execute,
  user,
  signal,
  record,
  timeoutMs = 60000,
  pollMs = 500,
}) {
  assert.ok(Number.isSafeInteger(user) && user > 0);
  for (const value of [timeoutMs, pollMs])
    assert.ok(Number.isSafeInteger(value) && value > 0);
  const deadline = AbortSignal.timeout(timeoutMs);
  const operationSignal = signal
    ? AbortSignal.any([signal, deadline])
    : deadline;
  let attempt = 0;
  try {
    for (;;) {
      operationSignal.throwIfAborted();
      assert.equal(
        String(
          await execute(["shell", "am", "get-current-user"], {
            signal: operationSignal,
          }),
        ).trim(),
        String(user),
        "Owned Android user changed before WebView admission",
      );
      const state = String(
        await execute(["shell", "dumpsys", "webviewupdate"], {
          signal: operationSignal,
        }),
      );
      const ready = androidWebViewReady(state);
      await record({ attempt: ++attempt, ready, state });
      if (ready) return;
      await delay(pollMs, undefined, { signal: operationSignal });
    }
  } catch (error) {
    if (deadline.aborted && !signal?.aborted)
      throw new Error("Owned user WebView readiness deadline exceeded", {
        cause: error,
      });
    throw error;
  }
}
