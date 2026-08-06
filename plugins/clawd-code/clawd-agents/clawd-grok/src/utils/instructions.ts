import * as fs from "fs";
import * as path from "path";
import { executeEventHooks } from "../hooks/index";
import type { InstructionsLoadedHookInput } from "../hooks/types";
import { findGitRoot } from "./git-root";
import { getHomeDir } from "./settings";

const instructionsHookFiredFor = new Set<string>();

function readNonEmptyFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const text = fs.readFileSync(filePath, "utf-8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function directoryChain(fromRoot: string, toCwd: string): string[] {
  const rel = path.relative(fromRoot, toCwd);
  if (rel === "") return [fromRoot];
  if (rel.startsWith("..")) return [toCwd];

  const segments = rel.split(path.sep).filter(Boolean);
  const chain: string[] = [];
  let acc = fromRoot;
  chain.push(acc);
  for (const segment of segments) {
    acc = path.join(acc, segment);
    chain.push(acc);
  }
  return chain;
}

function loadAgentsSegments(canonicalCwd: string): string[] {
  const segments: string[] = [];

  const homeDir = getHomeDir();
  const globalAgents =
    readNonEmptyFile(path.join(homeDir, ".clawd", "AGENTS.md")) ||
    readNonEmptyFile(path.join(homeDir, ".grok", "AGENTS.md"));
  if (globalAgents) segments.push(globalAgents);

  const root = findGitRoot(canonicalCwd) ?? canonicalCwd;
  for (const dir of directoryChain(root, canonicalCwd)) {
    const overridePath = path.join(dir, "AGENTS.override.md");
    if (fs.existsSync(overridePath)) {
      const text = readNonEmptyFile(overridePath);
      if (text) segments.push(text);
      continue;
    }
    const text = readNonEmptyFile(path.join(dir, "AGENTS.md"));
    if (text) segments.push(text);
  }

  return segments;
}

export function loadCustomInstructions(cwd: string): string | null {
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(cwd);
  } catch {
    canonical = path.resolve(cwd);
  }

  const parts: string[] = [...loadAgentsSegments(canonical)];

  if (parts.length === 0) return null;

  if (parts.length > 0 && !instructionsHookFiredFor.has(canonical)) {
    instructionsHookFiredFor.add(canonical);
    const hookInput: InstructionsLoadedHookInput = {
      hook_event_name: "InstructionsLoaded",
      files_loaded: parts.length,
      cwd: canonical,
    };
    executeEventHooks(hookInput, canonical).catch(() => {});
  }

  return parts.join("\n\n");
}
