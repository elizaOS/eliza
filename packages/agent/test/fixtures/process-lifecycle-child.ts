import fs from "node:fs";
import {
  createAgentProcessLifecycle,
  installProcessSignalHandlers,
} from "../../src/runtime/process-lifecycle.ts";

const [receipt, failure] = process.argv.slice(2);
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
lifecycle.addTeardown(() => {
  record("last");
  if (failure) throw new Error("teardown failed");
});
installProcessSignalHandlers({
  lifecycle,
  onError: () => {
    record("reported");
    if (failure === "reporter") throw new Error("reporter failed");
  },
});
setInterval(() => {}, 1_000);
process.kill(process.pid, "SIGTERM");
