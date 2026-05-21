import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DynamicViewManifest } from "../dynamic-views/types";

export const TRACE_DYNAMIC_VIEW_ID = "agent.run.trace";

const TRACE_VIEW_FILE = "agent-run-trace.html";

function currentDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function resolveTraceViewEntrypoint(): string {
  const baseDir = currentDir();
  const candidates = [
    path.join(baseDir, "views", TRACE_VIEW_FILE),
    path.join(baseDir, "trace", "views", TRACE_VIEW_FILE),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  return pathToFileURL(found ?? candidates[0]).href;
}

export function createTraceDynamicViewManifest(): DynamicViewManifest {
  return {
    id: TRACE_DYNAMIC_VIEW_ID,
    title: "Agent Run Trace",
    description: "Contextual trace view for agent runs and capability calls.",
    source: "system",
    entrypoint: resolveTraceViewEntrypoint(),
    placement: "floating",
    requiredRemotes: ["eliza.runtime"],
    eventSubscriptions: [{ remoteId: "eliza.runtime" }],
    invokeTargets: ["eliza.runtime"],
    metadata: {
      trace: true,
      productionPanel: false,
    },
  };
}
