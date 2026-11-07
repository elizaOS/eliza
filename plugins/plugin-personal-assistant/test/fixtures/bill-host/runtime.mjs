import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { buildTaskRuntime as build } from "../../../../../packages/app/scripts/build-consumer-task-runtime.mjs";

const sourceRoot = resolve(import.meta.dirname, "../../../../..");
export const buildTaskRuntime = (output) =>
  build(output, {
    sourceRoot,
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRoot,
      encoding: "utf8",
    }).trim(),
  });
