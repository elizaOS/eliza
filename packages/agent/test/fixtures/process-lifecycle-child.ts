import fs from "node:fs";
import {
  createAgentProcessLifecycle,
  installProcessSignalHandlers,
} from "../../src/runtime/process-lifecycle.ts";

const [receipt, failure, firstSignal = "SIGTERM", repeat] = process.argv.slice(
  2,
) as [string, string, NodeJS.Signals?, NodeJS.Signals?];
const record = (value: string) => fs.appendFileSync(receipt, `${value}\n`);
const lifecycle = createAgentProcessLifecycle({
  disposeRuntime: async () => {
    record("runtime");
  },
  disposeSandbox: async () => {
    record("sandbox");
  },
});
lifecycle.addTeardown(() => {
  record("first");
});
const failIfRequested = (): void => {
  if (failure) throw new Error("teardown failed");
};
lifecycle.addTeardown(() => {
  record("last");
  if (!repeat) return failIfRequested();
  return new Promise<void>((resolve) => {
    // Only observe delivery while the adapter still owns this signal.
    // Adding a listener in the default-action case would hide an early exit.
    if (process.listenerCount(repeat) > 0) {
      process.once(repeat, () => {
        record(`delivered ${repeat}`);
        resolve();
      });
    }
    process.kill(process.pid, repeat);
  }).then(failIfRequested);
});
installProcessSignalHandlers({
  lifecycle,
  onError: () => {
    record("reported");
    if (failure === "reporter") throw new Error("reporter failed");
  },
});
setInterval(() => {}, 1_000);
process.kill(process.pid, firstSignal);
