import { spawnSync } from "node:child_process";

const result = spawnSync(
  "bun",
  [
    "run",
    "--cwd",
    "plugins/plugin-inbox",
    "test",
    "test/mailbox/drafts-controller.test.ts",
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
