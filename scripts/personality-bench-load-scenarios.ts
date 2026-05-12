#!/usr/bin/env bun
/**
 * Personality bench scenario loader.
 *
 * Walks a directory tree (default: `test/scenarios/personality/`), imports
 * every `*.scenario.ts` module, and writes a single JSON array to stdout
 * with the fields the W3-4 runner needs:
 *
 *   [
 *     {
 *       id, bucket, title, description, tags, rooms, turns, personalityExpect,
 *       file
 *     },
 *     ...
 *   ]
 *
 * Run with `bun --bun scripts/personality-bench-load-scenarios.ts <dir>`.
 * Used by `scripts/personality-bench-run.mjs` (Node ESM orchestrator) so the
 * Node side stays free of TS-import concerns.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Room = {
  id: string;
  source?: string;
  channelType?: string;
  title?: string;
};

type Turn = {
  kind: string;
  name?: string;
  room?: string;
  text?: string;
  [key: string]: unknown;
};

type PersonalityExpect = {
  bucket: string;
  expectedBehavior?: string;
  judgeMode?: string;
  forbiddenContent?: unknown;
  requiredContent?: unknown;
  judgeKwargs?: Record<string, unknown>;
  directiveTurn?: number;
  checkTurns?: number[];
  options?: Record<string, unknown>;
};

type LoadedScenario = {
  id: string;
  bucket: string;
  title?: string;
  description?: string;
  tags?: readonly string[];
  rooms: Room[];
  turns: Turn[];
  personalityExpect: PersonalityExpect;
  file: string;
};

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir);
  for (const entry of entries) {
    if (entry.startsWith("_")) continue;
    const full = path.join(dir, entry);
    const st = await stat(full);
    if (st.isDirectory()) {
      await walk(full, out);
    } else if (entry.endsWith(".scenario.ts")) {
      out.push(full);
    }
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normaliseTurns(rawTurns: unknown): Turn[] {
  if (!Array.isArray(rawTurns)) return [];
  const out: Turn[] = [];
  for (const t of rawTurns) {
    const rec = asRecord(t);
    if (!rec) continue;
    const kind = asString(rec.kind);
    if (!kind) continue;
    out.push({
      kind,
      name: asString(rec.name),
      room: asString(rec.room),
      text: asString(rec.text),
    });
  }
  return out;
}

function normaliseRooms(rawRooms: unknown): Room[] {
  if (!Array.isArray(rawRooms)) return [];
  const out: Room[] = [];
  for (const r of rawRooms) {
    const rec = asRecord(r);
    if (!rec) continue;
    const id = asString(rec.id);
    if (!id) continue;
    out.push({
      id,
      source: asString(rec.source),
      channelType: asString(rec.channelType),
      title: asString(rec.title),
    });
  }
  return out;
}

function normalisePersonalityExpect(raw: unknown): PersonalityExpect | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const bucket = asString(rec.bucket);
  if (!bucket) return null;
  return {
    bucket,
    expectedBehavior: asString(rec.expectedBehavior),
    judgeMode: asString(rec.judgeMode),
    forbiddenContent: rec.forbiddenContent,
    requiredContent: rec.requiredContent,
    judgeKwargs: asRecord(rec.judgeKwargs),
    directiveTurn:
      typeof rec.directiveTurn === "number" ? rec.directiveTurn : undefined,
    checkTurns: Array.isArray(rec.checkTurns)
      ? (rec.checkTurns as number[]).filter((n) => typeof n === "number")
      : undefined,
    options: asRecord(rec.options),
  };
}

async function main(): Promise<void> {
  const root = process.argv[2];
  if (!root) {
    process.stderr.write("usage: personality-bench-load-scenarios.ts <dir>\n");
    process.exit(2);
  }
  const absRoot = path.resolve(root);
  const files: string[] = [];
  await walk(absRoot, files);
  files.sort();

  const loaded: LoadedScenario[] = [];
  for (const file of files) {
    const mod = (await import(pathToFileURL(file).href)) as {
      default?: unknown;
      scenario?: unknown;
    };
    const scenario = (mod.default ?? mod.scenario) as
      | Record<string, unknown>
      | undefined;
    if (!scenario || typeof scenario !== "object") {
      process.stderr.write(
        `[load-scenarios] skip ${file}: no default export\n`,
      );
      continue;
    }
    const id = asString(scenario.id);
    if (!id) {
      process.stderr.write(`[load-scenarios] skip ${file}: missing id\n`);
      continue;
    }
    const personalityExpect = normalisePersonalityExpect(
      scenario.personalityExpect,
    );
    if (!personalityExpect) {
      process.stderr.write(
        `[load-scenarios] skip ${file}: missing personalityExpect\n`,
      );
      continue;
    }
    loaded.push({
      id,
      bucket: personalityExpect.bucket,
      title: asString(scenario.title),
      description: asString(scenario.description),
      tags: Array.isArray(scenario.tags)
        ? (scenario.tags as string[]).filter((t) => typeof t === "string")
        : [],
      rooms: normaliseRooms(scenario.rooms),
      turns: normaliseTurns(scenario.turns),
      personalityExpect,
      file,
    });
  }

  process.stdout.write(JSON.stringify(loaded, null, 0));
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[load-scenarios] fatal: ${
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    }\n`,
  );
  process.exit(1);
});
