import fs from "node:fs";
import path from "node:path";
import { filesUnder } from "../util.ts";

const project = path.resolve(import.meta.dirname, "../..");
export const PACKED = [
  ...filesUnder(project, "patches"),
  ...fs.globSync("apps/*/package.json", { cwd: project }).map((file) => file.split(path.sep).join("/")),
  "package.json", "tsconfig.json", "tsconfig.build.json", "tsconfig.base.json", "turbo.json", "pnpm-workspace.yaml",
  "pnpm-lock.yaml", ".nvmrc", "README.md", "AGENTS.md", "SPEC.md", "LICENSE", ".agents/claude-settings.json",
];
export const toolShards = { a: "in shard a", b: "in shard b" };
