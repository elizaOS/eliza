/**
 * Discover hooks from workspace, managed state-dir hooks, and bundled dirs.
 * Later sources win on name conflicts.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  logger,
  parseFrontmatterDocument,
  resolveStateDir,
} from "@elizaos/core";
import type {
  ElizaHookMetadata,
  Hook,
  HookEntry,
  HookSource,
  ParsedHookFrontmatter,
} from "./types.ts";

const HOOK_MD = "HOOK.md";
const HANDLER_NAMES = [
  "handler.ts",
  "handler.mjs",
  "handler",
  "index.ts",
  "index.mjs",
  "index",
];

function decodeLegacyHookFrontmatter(
  raw: string,
): ParsedHookFrontmatter | null {
  const result: ParsedHookFrontmatter = { name: "", description: "" };
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\w+):\s*(.+)/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.replace(/^["']|["']$/g, "").trim();
    if (key === "name") result.name = value;
    else if (key === "description") result.description = value;
    else if (key === "homepage") result.homepage = value;
    else if (key === "metadata") {
      const metadataText = raw.slice(raw.indexOf(line) + line.indexOf(":") + 1);
      const json = metadataText.match(/\{[\s\S]*\}/)?.[0];
      if (json) {
        try {
          result.metadata = JSON.parse(
            json,
          ) as ParsedHookFrontmatter["metadata"];
        } catch {
          // error-policy:J3 legacy malformed metadata stays explicitly absent.
        }
      }
    }
  }
  return result.name ? result : null;
}

function parseFrontmatter(content: string): ParsedHookFrontmatter | null {
  const parsed = parseFrontmatterDocument(content);
  if (parsed.kind === "invalid") {
    return parsed.raw ? decodeLegacyHookFrontmatter(parsed.raw) : null;
  }
  if (parsed.kind === "none") return null;
  const { name, description, homepage, metadata } = parsed.frontmatter;
  if (typeof name !== "string" || !name.trim()) return null;
  if (typeof description !== "string") return null;
  const result: ParsedHookFrontmatter = {
    name: name.trim(),
    description: description.trim(),
  };
  if (typeof homepage === "string") result.homepage = homepage.trim();
  if (
    typeof metadata === "object" &&
    metadata !== null &&
    !Array.isArray(metadata)
  ) {
    result.metadata = metadata as ParsedHookFrontmatter["metadata"];
  }
  return result;
}

function extractMetadata(
  frontmatter: ParsedHookFrontmatter,
): ElizaHookMetadata | undefined {
  const meta = frontmatter.metadata?.eliza;
  if (!meta) return undefined;

  return {
    always: meta.always,
    hookKey: meta.hookKey,
    emoji: meta.emoji,
    homepage: meta.homepage ?? frontmatter.homepage,
    events: Array.isArray(meta.events) ? meta.events : [],
    export: meta.export,
    os: meta.os,
    requires: meta.requires,
    install: meta.install,
  };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function findHandlerPath(dir: string): Promise<string | null> {
  for (const name of HANDLER_NAMES) {
    const p = join(dir, name);
    if (await fileExists(p)) return p;
  }
  return null;
}

async function loadHookFromDir(
  dir: string,
  source: HookSource,
  pluginId?: string,
): Promise<HookEntry | null> {
  const hookMdPath = join(dir, HOOK_MD);

  if (!(await fileExists(hookMdPath))) return null;

  const handlerPath = await findHandlerPath(dir);
  if (!handlerPath) {
    logger.warn(`[hooks] Hook at ${dir} has HOOK.md but no handler`);
    return null;
  }

  try {
    const content = await readFile(hookMdPath, "utf-8");
    const frontmatter = parseFrontmatter(content);
    if (!frontmatter) {
      logger.warn(`[hooks] Invalid frontmatter in ${hookMdPath}`);
      return null;
    }

    const metadata = extractMetadata(frontmatter);

    const hook: Hook = {
      name: frontmatter.name,
      description: frontmatter.description,
      source,
      pluginId,
      filePath: hookMdPath,
      baseDir: dir,
      handlerPath,
    };

    return { hook, frontmatter, metadata };
  } catch (err) {
    const msg = String(err);
    logger.warn(`[hooks] Error loading hook from ${dir}: ${msg}`);
    return null;
  }
}

async function scanHooksDir(
  dir: string,
  source: HookSource,
): Promise<HookEntry[]> {
  if (!(await isDirectory(dir))) return [];

  const entries: HookEntry[] = [];

  try {
    const items = await readdir(dir);
    for (const item of items) {
      const itemPath = join(dir, item);
      if (!(await isDirectory(itemPath))) continue;

      const entry = await loadHookFromDir(itemPath, source);
      if (entry) {
        entries.push(entry);
      }
    }
  } catch (err) {
    const msg = String(err);
    logger.warn(`[hooks] Error scanning ${dir}: ${msg}`);
  }

  return entries;
}

export interface DiscoveryOptions {
  workspacePath?: string;
  bundledDir?: string;
  extraDirs?: string[];
}

/** Precedence: extra (lowest) -> bundled -> managed -> workspace (highest). */
export async function discoverHooks(
  options: DiscoveryOptions = {},
): Promise<HookEntry[]> {
  const seen = new Map<string, HookEntry>();

  if (options.extraDirs) {
    for (const dir of options.extraDirs) {
      const resolved = resolve(dir.replace(/^~/, homedir()));
      for (const entry of await scanHooksDir(resolved, "eliza-managed")) {
        seen.set(entry.hook.name, entry);
      }
    }
  }

  if (options.bundledDir) {
    for (const entry of await scanHooksDir(
      options.bundledDir,
      "eliza-bundled",
    )) {
      seen.set(entry.hook.name, entry);
    }
  }

  const managedDir = join(resolveStateDir(), "hooks");
  for (const entry of await scanHooksDir(managedDir, "eliza-managed")) {
    seen.set(entry.hook.name, entry);
  }

  if (options.workspacePath) {
    const wsHooksDir = join(
      options.workspacePath.replace(/^~/, homedir()),
      "hooks",
    );
    for (const entry of await scanHooksDir(wsHooksDir, "eliza-workspace")) {
      seen.set(entry.hook.name, entry);
    }
  }

  const all = Array.from(seen.values());
  logger.info(`[hooks] Discovered ${all.length} hooks`);
  return all;
}
