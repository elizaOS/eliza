import { resolve } from "node:path";
import {
  discoverSdkUnitTests,
  runCommandWithWatchdog,
} from "../../../scripts/test-cloud-run.ts";

const root = resolve(import.meta.dirname, "../../sdk");
const commands: Array<[string, string[]]> = [
  ["bun", ["test", ...discoverSdkUnitTests(resolve(root, "src")), "--isolate"]],
  [
    "node",
    [
      "--test",
      "--test-concurrency=1",
      ...discoverSdkUnitTests(resolve(root, "native-host")),
    ],
  ],
];
for (const [command, args] of commands) {
  const result = await runCommandWithWatchdog(command, args, {
    cwd: root,
    env: process.env,
    writeOut: (text) => process.stdout.write(text),
    writeErr: (text) => process.stderr.write(text),
  });
  if (result.error) console.error(result.error);
  if (result.terminationError) console.error(result.terminationError);
  if (
    result.status !== 0 ||
    result.timedOut ||
    result.parentSignal ||
    result.error ||
    result.terminationError
  ) {
    process.exitCode = 1;
  }
  if (result.parentSignal) break;
}
