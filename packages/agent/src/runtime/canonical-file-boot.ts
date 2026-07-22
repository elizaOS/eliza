/**
 * Canonical file boot (sovereign runtime, direct-from-file identity).
 *
 * A self-hosted, single-tenant runtime that wants its identity to be the
 * operator's real, hand-authored files (SOUL.md, IDENTITY.md, AGENTS.md,
 * USER.md, a memory system handoff, etc.) should NOT depend on a separately
 * maintained compressed character JSON as the source of truth. A JSON shadow
 * copy drifts: it silently goes stale while the real files move on, and there
 * is no boot-time proof that what the model sees matches the files on disk.
 *
 * This module composes an allowlisted MANIFEST of files into the boot
 * character's system prompt. At boot it:
 *   1. resolves a manifest (explicit JSON manifest file, or a root dir + a
 *      default filename list) — generic, not tied to any one operator's paths;
 *   2. reads each allowlisted file, computes a sha256 of the exact bytes, and
 *      logs `<sha256>  <label>` so the boot log is an auditable content record;
 *   3. FAILS LOUDLY (throws) if a file marked `required` is missing or empty —
 *      a sovereign identity boot must not silently fall back to a default
 *      preset when the operator's own soul file vanished;
 *   4. appends the exact file contents, wrapped in labeled delimiters, onto
 *      the primary agent's `system` prompt so the model receives them verbatim
 *      in boot context.
 *
 * It reads files READ-ONLY. It does not write, and it does not manage the
 * daily/handoff WRITE root (that is a separate controlled-write concern).
 *
 * Inert by default: with no manifest env configured it returns the config
 * unchanged, so every non-sovereign runtime is unaffected.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";

import { logger } from "@elizaos/core";
import type { ElizaConfig } from "../config/config.ts";

/**
 * Default canonical file set, resolved relative to
 * `ELIZA_CANONICAL_BOOT_ROOT` when no explicit manifest is provided. Order is
 * the boot-context order. `required: true` files fail the boot loudly when
 * absent; the rest are best-effort (a handoff or awareness file may legitimately
 * not exist yet on a fresh workspace).
 */
export const DEFAULT_CANONICAL_MANIFEST: CanonicalManifestEntry[] = [
  { label: "SOUL.md", relPath: "SOUL.md", required: true },
  { label: "IDENTITY.md", relPath: "IDENTITY.md", required: true },
  { label: "AGENTS.md", relPath: "AGENTS.md", required: true },
  { label: "USER.md", relPath: "USER.md", required: true },
  { label: "TOOLS.md", relPath: "TOOLS.md", required: false },
  { label: "memory/SYSTEM.md", relPath: "memory/SYSTEM.md", required: false },
  { label: "memory/HANDOFF.md", relPath: "memory/HANDOFF.md", required: false },
  {
    label: "memory/sol-awareness.md",
    relPath: "memory/sol-awareness.md",
    required: false,
  },
  {
    label: "memory/conversation-playbook.md",
    relPath: "memory/conversation-playbook.md",
    required: false,
  },
  {
    label: "memory/channel-guide.md",
    relPath: "memory/channel-guide.md",
    required: false,
  },
];

/** One allowlisted file in the boot manifest. */
export interface CanonicalManifestEntry {
  /** Human-readable label used in the composed block header and the sha log. */
  label: string;
  /**
   * Path to read. When resolved from `DEFAULT_CANONICAL_MANIFEST` this is a
   * path relative to `ELIZA_CANONICAL_BOOT_ROOT`. An explicit manifest entry
   * may instead carry an absolute `path`.
   */
  relPath?: string;
  /** Absolute (or manifest-root-relative) explicit path from a JSON manifest. */
  path?: string;
  /** When true, a missing/empty file throws and aborts boot. */
  required?: boolean;
}

/** Result of composing the canonical boot context. */
export interface CanonicalBootComposition {
  /** The composed text to append to the system prompt (empty when nothing read). */
  text: string;
  /** Per-file audit record: label -> { path, sha256, bytes, present }. */
  audit: CanonicalFileAudit[];
}

export interface CanonicalFileAudit {
  label: string;
  path: string;
  present: boolean;
  bytes: number;
  /** sha256 hex of the exact file bytes, or null when the file was absent. */
  sha256: string | null;
}

/** Minimal filesystem surface, injectable for tests (no real disk needed). */
export interface CanonicalBootFs {
  readFileSync(path: string): Buffer | string;
}

const DEFAULT_FS: CanonicalBootFs = {
  readFileSync: (p: string) => readFileSync(p),
};

/** Env keys that drive canonical file boot. */
export const CANONICAL_BOOT_ROOT_ENV = "ELIZA_CANONICAL_BOOT_ROOT";
export const CANONICAL_BOOT_MANIFEST_ENV = "ELIZA_CANONICAL_BOOT_MANIFEST";

interface ManifestFileShape {
  /** Optional root the entries' relative paths resolve against. */
  root?: string;
  files?: Array<{
    label?: string;
    path?: string;
    relPath?: string;
    required?: boolean;
  }>;
}

/**
 * Resolve the effective manifest (absolute path per entry) from the
 * environment. Returns null when canonical file boot is not configured, so the
 * caller stays inert.
 *
 * Two modes:
 *  - `ELIZA_CANONICAL_BOOT_MANIFEST=/path/to/manifest.json`: an explicit
 *    manifest listing files (each with a path, optional label/required). Paths
 *    resolve against the manifest's own `root` (if given) else the manifest
 *    file's directory is NOT assumed — absolute paths are used as-is and
 *    relative paths resolve against `ELIZA_CANONICAL_BOOT_ROOT` or cwd.
 *  - `ELIZA_CANONICAL_BOOT_ROOT=/path/to/workspace`: use the built-in
 *    DEFAULT_CANONICAL_MANIFEST, resolving each relPath under that root.
 */
export function resolveCanonicalManifest(
  env: NodeJS.ProcessEnv = process.env,
  fs: CanonicalBootFs = DEFAULT_FS,
): ResolvedCanonicalEntry[] | null {
  const manifestPath = env[CANONICAL_BOOT_MANIFEST_ENV]?.trim();
  const root = env[CANONICAL_BOOT_ROOT_ENV]?.trim();

  if (manifestPath) {
    let parsed: ManifestFileShape;
    try {
      const raw = bufferToString(fs.readFileSync(manifestPath));
      parsed = JSON.parse(raw) as ManifestFileShape;
    } catch (err) {
      // A configured-but-broken manifest is an operator error we must not
      // paper over: fail loudly rather than silently boot a default preset.
      throw new Error(
        `[canonical-file-boot] Failed to read/parse manifest at ${manifestPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const manifestRoot = parsed.root?.trim() || root || process.cwd();
    const files = Array.isArray(parsed.files) ? parsed.files : [];
    return files
      .filter((f) => (f.path ?? f.relPath)?.trim())
      .map((f) => {
        const rawPath = (f.path ?? f.relPath) as string;
        const abs = isAbsolute(rawPath)
          ? rawPath
          : resolvePath(manifestRoot, rawPath);
        return {
          label: f.label?.trim() || rawPath,
          path: abs,
          required: f.required === true,
        };
      });
  }

  if (root) {
    return DEFAULT_CANONICAL_MANIFEST.map((entry) => ({
      label: entry.label,
      path: resolvePath(root, entry.relPath ?? entry.label),
      required: entry.required === true,
    }));
  }

  return null;
}

export interface ResolvedCanonicalEntry {
  label: string;
  /** Absolute path to read. */
  path: string;
  required: boolean;
}

/**
 * Read the manifest files and compose them into a single boot-context string.
 * Computes and (optionally) logs a sha256 per file. Throws if a `required`
 * file is missing or empty.
 */
export function composeCanonicalBootContext(
  manifest: ResolvedCanonicalEntry[],
  opts: { fs?: CanonicalBootFs; log?: boolean } = {},
): CanonicalBootComposition {
  const fs = opts.fs ?? DEFAULT_FS;
  const log = opts.log ?? true;
  const audit: CanonicalFileAudit[] = [];
  const blocks: string[] = [];

  for (const entry of manifest) {
    let content: string | null = null;
    try {
      content = bufferToString(fs.readFileSync(entry.path));
    } catch {
      content = null;
    }

    if (content === null || content.trim() === "") {
      if (entry.required) {
        throw new Error(
          `[canonical-file-boot] Required canonical file missing or empty: ${entry.label} (${entry.path}). ` +
            "Refusing to boot the sovereign identity from an incomplete file set.",
        );
      }
      audit.push({
        label: entry.label,
        path: entry.path,
        present: false,
        bytes: 0,
        sha256: null,
      });
      if (log) {
        logger.warn(
          `[canonical-file-boot] optional file absent: ${entry.label} (${entry.path})`,
        );
      }
      continue;
    }

    const bytes = Buffer.byteLength(content, "utf8");
    const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
    audit.push({
      label: entry.label,
      path: entry.path,
      present: true,
      bytes,
      sha256,
    });
    if (log) {
      logger.info(
        `[canonical-file-boot] ${sha256}  ${entry.label} (${bytes} bytes)`,
      );
    }
    blocks.push(
      `<<<CANONICAL FILE: ${entry.label} sha256=${sha256}>>>\n${content}\n<<<END ${entry.label}>>>`,
    );
  }

  const text =
    blocks.length > 0
      ? `# Canonical boot files (read verbatim from disk)\n\n${blocks.join(
          "\n\n",
        )}`
      : "";

  return { text, audit };
}

/**
 * Apply canonical file boot onto the runtime config. Reads the manifest,
 * composes the file contents, and appends them to the primary agent's system
 * prompt. Returns the (mutated) config for chaining.
 *
 * Inert when no manifest env is configured. Throws when configured but a
 * required file is missing — a loud failure is the point.
 */
export function applyCanonicalFileBootToConfig(
  config: ElizaConfig,
  env: NodeJS.ProcessEnv = process.env,
  deps: { fs?: CanonicalBootFs; log?: boolean } = {},
): ElizaConfig {
  const manifest = resolveCanonicalManifest(env, deps.fs);
  if (!manifest || manifest.length === 0) return config;

  const { text, audit } = composeCanonicalBootContext(manifest, deps);
  if (!text) return config;

  const agents = config.agents;
  const list = Array.isArray(agents?.list) ? [...agents.list] : [];
  let idx = list.findIndex((a) => a?.default);
  if (idx < 0) {
    // No primary entry yet: create a minimal one so the composed identity
    // still lands. buildCharacterFromConfig fills name/bio from the preset.
    list.unshift({ id: "main", default: true, name: "" });
    idx = 0;
  }

  const existing = list[idx];
  const priorSystem =
    typeof existing?.system === "string" ? existing.system : "";
  const nextSystem = priorSystem ? `${priorSystem}\n\n${text}` : text;
  list[idx] = { ...existing, system: nextSystem };
  config.agents = agents ? { ...agents, list } : { list };

  const present = audit.filter((a) => a.present).length;
  if (deps.log ?? true) {
    logger.info(
      `[canonical-file-boot] Composed ${present}/${audit.length} canonical files into the primary agent system prompt.`,
    );
  }

  return config;
}

function bufferToString(v: Buffer | string): string {
  return typeof v === "string" ? v : v.toString("utf8");
}
