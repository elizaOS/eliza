/** Fresh-process harness for proving that post-capture PATH writes do not replace boot authority. */

import {
  captureHostExecutionBaseline,
  getHostExecutionBaseline,
} from "@elizaos/core/host-execution-env";

captureHostExecutionBaseline();
process.env.PATH = process.env.ELIZA_TEST_MUTATED_PATH;
process.stdout.write(JSON.stringify(getHostExecutionBaseline()));
