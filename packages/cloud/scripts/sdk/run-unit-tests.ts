import { resolve } from "node:path";
import {
  discoverSdkUnitTests,
  runCommandWithWatchdog,
} from "../../../scripts/test-cloud-run.ts";

const root = resolve(import.meta.dirname, "../../sdk");
const result = await runCommandWithWatchdog(
  "bun",
  ["test", ...discoverSdkUnitTests(resolve(root, "src")), "--isolate"],
  {
    cwd: root,
    env: process.env,
    writeOut: (text) => process.stdout.write(text),
    writeErr: (text) => process.stderr.write(text),
  },
);
if (result.error) console.error(result.error);
if (result.terminationError) console.error(result.terminationError);
process.exitCode =
  result.status === 0 &&
  !result.timedOut &&
  !result.parentSignal &&
  !result.error &&
  !result.terminationError
    ? 0
    : 1;
