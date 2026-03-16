/**
 * Discover hooks from workspace, managed (~/.milady/hooks/), and bundled dirs.
 * Later sources win on name conflicts.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { logger } from "@elizaos/core";
import type {
  Hook,
  HookEntry,
  HookSource,
  MiladyHookMetadata,
  ParsedHookFrontmatter,
} from "./types";

const HOOK_MD = "HOOK.md";
const HANDLER_NAMES = ["handler.ts", "handler", "index.ts", "index"];

function parseFrontmatter(content: string): ParsedHookFrontmatter | null {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const fmBlock = fmMatch[1];
  const result: ParsedHookFrontmatter = { name: "", description: "" };

  for (const line of fmBlock.split("\n")) {
    const kvMatch = line.match(/^(\w+):\s*(.+)/);
    if (!kvMatch) continue;
    const [, key, rawValue] = kvMatch;
    const value = rawValue.replace(/^["']|["']$/g, "").trim();

    switch (key) {
      case "name":
        result.name = value;
        break;
      case "description":
        result.description = value;
        break;
      case "homepage":
        result.homepage = value;
        break;
      case "metadata":
        try {
          const metaStart = fmBlock.indexOf("metadata:");
          if (metaStart !== -1) {
            const metaRest = fmBlock
              .slice(metaStart + "metadata:".length)
              .trim();
            const jsonMatch = metaRest.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              result.metadata = JSON.parse(jsonMatch[0]);
            }
          }
        } catch {
          try {
            result.metadata = JSON.parse(value);
          } catch {
            logger.warn(`[hooks] Failed to parse metadata in HOOK.md`);
          }
        }
        break;
    }
  }

  return result.name ? result : null;
}

function extractMetadata(
  frontmatter: ParsedHookFrontmatter,
): MiladyHookMetadata | undefined {
  const milady = frontmatter.metadata?.milady;
  if (!milady) return undefined;

  return {
    always: milady.always,
    hookKey: milady.hookKey,
    emoji: milady.emoji,
    homepage: milady.homepage ?? frontmatter.homepage,
    events: Array.isArray(milady.events) ? milady.events : [],
    export: milady.export,
    os: milady.os,
    requires: milady.requires,
    install: milady.install,
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
    const msg = err instanceof Error ? err.message : String(err);
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
    const msg = err instanceof Error ? err.message : String(err);
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
      for (const entry of await scanHooksDir(resolved, "milady-managed")) {
        seen.set(entry.hook.name, entry);
      }
    }
  }

  if (options.bundledDir) {
    for (const entry of await scanHooksDir(
      options.bundledDir,
      "milady-bundled",
    )) {
      seen.set(entry.hook.name, entry);
    }
  }

  const managedDir = join(homedir(), ".milady", "hooks");
  for (const entry of await scanHooksDir(managedDir, "milady-managed")) {
    seen.set(entry.hook.name, entry);
  }

  if (options.workspacePath) {
    const wsHooksDir = join(
      options.workspacePath.replace(/^~/, homedir()),
      "hooks",
    );
    for (const entry of await scanHooksDir(wsHooksDir, "milady-workspace")) {
      seen.set(entry.hook.name, entry);
    }
  }

  const all = Array.from(seen.values());
  logger.info(`[hooks] Discovered ${all.length} hooks`);
  return all;
}
