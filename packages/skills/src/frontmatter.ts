/**
 * YAML frontmatter parsing and serialization for SKILL.md files: extracts the
 * metadata block, resolves skill metadata / invocation policy / provenance from
 * it, and writes it back. Provenance records whether a skill is human-authored,
 * agent-generated, or agent-refined (see types.ts).
 */
import { ElizaError, parseFrontmatterDocument } from "@elizaos/core";
import { stringify } from "yaml";
import type {
  SkillFrontmatter,
  SkillInvocationPolicy,
  SkillMetadata,
  SkillProvenance,
} from "./types.js";

export interface ParsedFrontmatter<T extends Record<string, unknown>> {
  frontmatter: T;
  body: string;
}

/** Stable error code raised when a SKILL.md frontmatter block is invalid YAML. */
export const INVALID_SKILL_FRONTMATTER_YAML = "INVALID_SKILL_FRONTMATTER_YAML";

/**
 * True only for plain string-keyed records (Object.prototype or null-prototype).
 * yaml.parse can return Set/Map/collection instances for !!set / !!omap roots;
 * those must not be typed or returned as Record<string, unknown>.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function frontmatterValue(
  frontmatter: SkillFrontmatter,
  kebabKey: string,
  snakeKey: string,
): unknown {
  return frontmatter[kebabKey] ?? frontmatter[snakeKey];
}

function stringList(value: unknown, transform: (value: string) => string) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value
    .filter((item): item is string => typeof item === "string")
    .map(transform)
    .filter((item) => item.length > 0);
  return out.length > 0 ? out : undefined;
}

/**
 * Parses a Markdown document's YAML frontmatter and returns its body.
 *
 * @throws {ElizaError} With code `INVALID_SKILL_FRONTMATTER_YAML` when a
 * delimited frontmatter block contains malformed YAML.
 */
export function parseFrontmatter<
  T extends Record<string, unknown> = Record<string, unknown>,
>(content: string): ParsedFrontmatter<T> {
  const parsed = parseFrontmatterDocument(content);
  if (parsed.kind === "none") {
    return { frontmatter: {} as T, body: parsed.body };
  }
  if (parsed.kind === "invalid") {
    if (parsed.code === "invalid-delimiter") {
      return { frontmatter: {} as T, body: parsed.body };
    }
    if (parsed.code === "invalid-root") {
      return { frontmatter: {} as T, body: parsed.body.trim() };
    }
    // error-policy:J2 preserve the canonical parser failure behind a stable domain code
    throw new ElizaError("Skill frontmatter contains invalid YAML", {
      code: INVALID_SKILL_FRONTMATTER_YAML,
      context: { parser: "yaml", reason: parsed.code },
      cause: parsed.cause,
    });
  }
  return {
    frontmatter: parsed.frontmatter as T,
    body: parsed.body.trim(),
  };
}

/**
 * Removes a Markdown document's YAML frontmatter and returns its body.
 *
 * @throws {ElizaError} With code `INVALID_SKILL_FRONTMATTER_YAML` when a
 * delimited frontmatter block contains malformed YAML.
 */
export function stripFrontmatter(content: string): string {
  return parseFrontmatter(content).body;
}

export function resolveSkillMetadata(
  frontmatter: SkillFrontmatter,
): SkillMetadata {
  const metadata: SkillMetadata = {};

  const primaryEnv = frontmatterValue(
    frontmatter,
    "primary-env",
    "primary_env",
  );
  if (typeof primaryEnv === "string" && primaryEnv.trim()) {
    metadata.primaryEnv = primaryEnv.trim();
  }

  const requiredOs = stringList(
    frontmatterValue(frontmatter, "required-os", "required_os"),
    (os) => os.trim().toLowerCase(),
  );
  if (requiredOs) {
    metadata.requiredOs = requiredOs;
  }

  const requiredBins = stringList(
    frontmatterValue(frontmatter, "required-bins", "required_bins"),
    (bin) => bin.trim(),
  );
  if (requiredBins) {
    metadata.requiredBins = requiredBins;
  }

  const requiredEnv = stringList(
    frontmatterValue(frontmatter, "required-env", "required_env"),
    (env) => env.trim(),
  );
  if (requiredEnv) {
    metadata.requiredEnv = requiredEnv;
  }

  return metadata;
}

export function resolveSkillInvocationPolicy(
  frontmatter: SkillFrontmatter,
): SkillInvocationPolicy {
  const policy: SkillInvocationPolicy = {};

  const disableModelInvocation = frontmatterValue(
    frontmatter,
    "disable-model-invocation",
    "disable_model_invocation",
  );
  if (disableModelInvocation === true) {
    policy.disableModelInvocation = true;
  }

  const userInvocable = frontmatterValue(
    frontmatter,
    "user-invocable",
    "user_invocable",
  );
  if (userInvocable === false) {
    policy.userInvocable = false;
  }

  return policy;
}

/**
 * Best-effort provenance parsing from a frontmatter block. Returns `undefined`
 * when the block is missing or malformed (we do not fail loading on bad
 * provenance — it is informational metadata).
 */
export function resolveSkillProvenance(
  frontmatter: SkillFrontmatter,
): SkillProvenance | undefined {
  const raw = frontmatter.provenance;
  if (!isRecord(raw)) {
    return undefined;
  }
  const source = raw.source;
  if (
    source !== "human" &&
    source !== "agent-generated" &&
    source !== "agent-refined"
  ) {
    return undefined;
  }
  const createdAt =
    typeof raw.createdAt === "string" ? raw.createdAt : undefined;
  if (!createdAt) {
    return undefined;
  }
  const refinedCountRaw = raw.refinedCount;
  const refinedCount =
    typeof refinedCountRaw === "number" && Number.isFinite(refinedCountRaw)
      ? Math.max(0, Math.floor(refinedCountRaw))
      : 0;
  const provenance: SkillProvenance = {
    source,
    createdAt,
    refinedCount,
  };
  if (typeof raw.derivedFromTrajectory === "string") {
    provenance.derivedFromTrajectory = raw.derivedFromTrajectory;
  }
  if (
    typeof raw.lastEvalScore === "number" &&
    Number.isFinite(raw.lastEvalScore)
  ) {
    const score = raw.lastEvalScore;
    provenance.lastEvalScore = Math.max(0, Math.min(1, score));
  }
  return provenance;
}

/**
 * Serialize a SKILL.md file with updated frontmatter, preserving body content.
 * Used by the closed learning loop to rewrite provenance after refinement and
 * scoring.
 */
export function serializeSkillFile(
  frontmatter: SkillFrontmatter,
  body: string,
): string {
  const yaml = stringify(frontmatter).trimEnd();
  const trimmedBody = body.replace(/^\n+/, "");
  return `---\n${yaml}\n---\n\n${trimmedBody}`;
}
