/**
 * Zero-dependency character JSON path resolution and system-prompt synthesis.
 *
 * Kept free of @elizaos/* imports so monorepo operators (and verification
 * scripts) can load characters/clawd.json without a full workspace install.
 * `sandbox-character.ts` consumes these helpers and owns the config merge.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

/** Loose character JSON shape accepted from disk / env injection. */
export interface CharacterFileJson {
  id?: string;
  name?: string;
  username?: string;
  system?: string;
  bio?: string[] | string;
  lore?: string[] | string;
  topics?: string[];
  adjectives?: string[];
  postExamples?: string[];
  style?: { all?: string[]; chat?: string[]; post?: string[] };
  messageExamples?: unknown;
  settings?: unknown;
  knowledge?: unknown;
  connectors?: Record<string, unknown>;
  [key: string]: unknown;
}

export type CharacterJsonSource = "json" | "path";

export interface ResolvedCharacterJson {
  raw: string;
  source: CharacterJsonSource;
  path?: string;
}

/** Expand `~` and resolve relative paths against cwd. */
export function resolveCharacterFilePath(
  input: string,
  cwd: string = process.cwd(),
): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return resolve(homedir(), trimmed.slice(2));
  }
  if (isAbsolute(trimmed)) return trimmed;
  return resolve(cwd, trimmed);
}

export function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string" && value.trim()) return [value];
  return undefined;
}

/**
 * Resolve the raw character JSON string from env.
 * Precedence: `ELIZA_AGENT_CHARACTER_JSON` > file at `ELIZA_AGENT_CHARACTER_PATH`.
 */
export function resolveSandboxCharacterJsonFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  onWarn: (message: string) => void = () => {},
): ResolvedCharacterJson | null {
  const inline = env.ELIZA_AGENT_CHARACTER_JSON?.trim();
  if (inline) {
    return { raw: inline, source: "json" };
  }

  const pathValue = env.ELIZA_AGENT_CHARACTER_PATH?.trim();
  if (!pathValue) return null;

  const resolved = resolveCharacterFilePath(pathValue, cwd);
  if (!existsSync(resolved)) {
    onWarn(
      `[sandbox-character] ELIZA_AGENT_CHARACTER_PATH does not exist: ${resolved}`,
    );
    return null;
  }

  try {
    const raw = readFileSync(resolved, "utf8");
    return { raw, source: "path", path: resolved };
  } catch (err) {
    onWarn(
      `[sandbox-character] Failed to read ELIZA_AGENT_CHARACTER_PATH (${resolved}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Build a system prompt when the character JSON omits `system` (common for
 * catalog characters that only ship bio/lore/style).
 */
export function resolveSystemFromCharacter(
  parsed: CharacterFileJson,
): string | undefined {
  if (typeof parsed.system === "string" && parsed.system.trim()) {
    return parsed.system.trim();
  }

  const parts: string[] = [];
  const name = parsed.name?.trim();
  if (name) {
    parts.push(`You are ${name}.`);
  }

  const bio = asStringArray(parsed.bio);
  if (bio?.length) {
    parts.push(bio.join("\n"));
  }

  const lore = asStringArray(parsed.lore);
  if (lore?.length) {
    parts.push(lore.join("\n"));
  }

  const styleAll = parsed.style?.all;
  if (Array.isArray(styleAll) && styleAll.length > 0) {
    parts.push(
      "Style:\n" +
        styleAll
          .filter(
            (line): line is string =>
              typeof line === "string" && !!line.trim(),
          )
          .map((line) => `- ${line}`)
          .join("\n"),
    );
  }

  const system = parts.join("\n\n").trim();
  return system || undefined;
}

/** Parse character JSON text; returns null on failure. */
export function parseCharacterJson(
  raw: string,
): CharacterFileJson | null {
  try {
    const parsed = JSON.parse(raw) as CharacterFileJson;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Load + parse character from env (JSON or path). Pure: no config mutation.
 */
export function loadCharacterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  onWarn: (message: string) => void = () => {},
): {
  parsed: CharacterFileJson;
  source: CharacterJsonSource;
  path?: string;
  system?: string;
} | null {
  const resolved = resolveSandboxCharacterJsonFromEnv(env, cwd, onWarn);
  if (!resolved) return null;
  const parsed = parseCharacterJson(resolved.raw);
  if (!parsed) {
    const label =
      resolved.source === "path"
        ? `ELIZA_AGENT_CHARACTER_PATH (${resolved.path})`
        : "ELIZA_AGENT_CHARACTER_JSON";
    onWarn(
      `[sandbox-character] ${label} is not valid JSON; booting with default character`,
    );
    return null;
  }
  return {
    parsed,
    source: resolved.source,
    path: resolved.path,
    system: resolveSystemFromCharacter(parsed),
  };
}
