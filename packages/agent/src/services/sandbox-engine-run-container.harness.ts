/** Drives Apple Container startup in a subprocess for inherited-stdio boundary tests. */

import { mock } from "node:test";
import { ElizaError } from "@elizaos/core";
import {
  AppleContainerEngine,
  type ContainerRunOptions,
} from "./sandbox-engine.ts";

// The stderr boundary test observes a real child exit without racing the
// startup grace timer against Node launch or pipe-drain scheduling. Its outer
// process still enforces a real timeout; ordinary startup tests use real time.
if (process.env.ELIZA_TEST_HOLD_STARTUP_CHECK === "1") {
  mock.timers.enable({ apis: ["setTimeout"] });
}

const mode = process.argv[2];
const name =
  mode === "stdout" ? "eliza-sandbox-stdout" : "eliza-sandbox-immediate-exit";
const options: ContainerRunOptions = {
  image: "eliza-sandbox:test",
  name,
  detach: true,
  mounts: [],
  env: {},
  network: "none",
  user: "",
  capDrop: [],
};

function writeResult(result: string, exitCode: number): void {
  process.stdout.write(result, () => process.exit(exitCode));
}

try {
  const resolved = await new AppleContainerEngine().runContainer(options);
  writeResult(`HARNESS_RESOLVED:${resolved}\n`, mode === "stdout" ? 0 : 1);
} catch (error) {
  const typed = error instanceof ElizaError;
  const failure = error as Partial<ElizaError> & Error;
  writeResult(
    `${JSON.stringify({
      kind: "rejected",
      isElizaError: typed,
      code: failure.code,
      context: failure.context,
      message: failure.message,
    })}\n`,
    mode === "immediate-exit" && typed ? 0 : 1,
  );
}
