import path from "node:path";
import { fileURLToPath } from "node:url";
import { runManagedTestCommand } from "./managed-test-command.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

await runManagedTestCommand({
  repoRoot,
  lockName: "cleanup",
  label: "cleanup",
  command: process.platform === "win32" ? "cmd" : "true",
  args: process.platform === "win32" ? ["/c", "exit", "0"] : [],
  cwd: repoRoot,
});
