import { parse, stringify } from "yaml";
import type {
  SkillFrontmatter,
  SkillInvocationPolicy,
  SkillMetadata,
  SkillProvenance,
} from "./types.js";

/**
 * Result of parsing frontmatter from a file
 */
export interface ParsedFrontmatter<T extends Record<string, unknown>> {
  /** Parsed frontmatter object */
  frontmatter: T;
  /** Remaining body content after frontmatter */
  body: string;
}

/**
 * Normalize line endings to Unix-style LF
 */
function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Extract YAML frontmatter block from content
 * Frontmatter must start with --- on the first line and end with --- on its own line
 */
function extractFrontmatter(content: string): {
  yamlString: string | null;
  body: string;
} {
  const normalized = normalizeNewlines(content);

  if (!normalized.startsWith("---")) {
    return { yamlString: null, body: normalized };
  }

  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { yamlString: null, body: normalized };
  }

  return {
    yamlString: normalized.slice(4, endIndex),
    body: normalized.slice(endIndex + 4).trim(),
  };
}

/**
 * Parse YAML frontmatter from markdown content
 *
 * @param content - Raw file content with optional YAML frontmatter
 * @returns Parsed frontmatter object and remaining body
 */
export function parseFrontmatter<
  T extends Record<string, unknown> = Record<string, unknown>,
>(content: string): ParsedFrontmatter<T> {
  const { yamlString, body } = extractFrontmatter(content);
  if (!yamlString) {
    return { frontmatter: {} as T, body };
  }
  const parsed = parse(yamlString);
  return { frontmatter: (parsed ?? {}) as T, body };
}

/**
 * Strip frontmatter from content and return only the body
 *
 * @param content - Raw file content with optional YAML frontmatter
 * @returns Content without frontmatter
 */
export function stripFrontmatter(content: string): string {
  return parseFrontmatter(content).body;
}

/**
 * Resolve skill metadata from skill frontmatter
 *
 * @param frontmatter - Parsed skill frontmatter
 * @returns Normalized metadata object
 */
export function resolveSkillMetadata(
  frontmatter: SkillFrontmatter,
): SkillMetadata {
  const metadata: SkillMetadata = {};

  // Primary environment
  const primaryEnv = frontmatter["primary-env"] ?? frontmatter.primary_env;
  if (typeof primaryEnv === "string" && primaryEnv.trim()) {
    metadata.primaryEnv = primaryEnv.trim();
  }

  // Required operating systems
  const requiredOs = frontmatter["required-os"] ?? frontmatter.required_os;
  if (Array.isArray(requiredOs)) {
    metadata.requiredOs = requiredOs
      .filter((os): os is string => typeof os === "string")
      .map((os) => os.trim().toLowerCase());
  }

  // Required binaries
  const requiredBins =
    frontmatter["required-bins"] ?? frontmatter.required_bins;
  if (Array.isArray(requiredBins)) {
    metadata.requiredBins = requiredBins
      .filter((bin): bin is string => typeof bin === "string")
      .map((bin) => bin.trim());
  }

  // Required environment variables
  const requiredEnv = frontmatter["required-env"] ?? frontmatter.required_env;
  if (Array.isArray(requiredEnv)) {
    metadata.requiredEnv = requiredEnv
      .filter((env): env is string => typeof env === "string")
      .map((env) => env.trim());
  }

  return metadata;
}

/**
 * Resolve skill invocation policy from frontmatter
 *
 * @param frontmatter - Parsed skill frontmatter
 * @returns Invocation policy
 */
export function resolveSkillInvocationPolicy(
  frontmatter: SkillFrontmatter,
): SkillInvocationPolicy {
  const policy: SkillInvocationPolicy = {};

  // Disable model invocation (snake_case and kebab-case)
  const disableModelInvocation =
    frontmatter["disable-model-invocation"] ??
    frontmatter.disable_model_invocation;
  if (disableModelInvocation === true) {
    policy.disableModelInvocation = true;
  }

  // User invocable (snake_case and kebab-case)
  const userInvocable =
    frontmatter["user-invocable"] ?? frontmatter.user_invocable;
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
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as unknown as Record<string, unknown>;
  const source = record.source;
  if (
    source !== "human" &&
    source !== "agent-generated" &&
    source !== "agent-refined"
  ) {
    return undefined;
  }
  const createdAt =
    typeof record.createdAt === "string" ? record.createdAt : undefined;
  if (!createdAt) {
    return undefined;
  }
  const refinedCountRaw = record.refinedCount;
  const refinedCount =
    typeof refinedCountRaw === "number" && Number.isFinite(refinedCountRaw)
      ? Math.max(0, Math.floor(refinedCountRaw))
      : 0;
  const provenance: SkillProvenance = {
    source,
    createdAt,
    refinedCount,
  };
  if (typeof record.derivedFromTrajectory === "string") {
    provenance.derivedFromTrajectory = record.derivedFromTrajectory;
  }
  if (
    typeof record.lastEvalScore === "number" &&
    Number.isFinite(record.lastEvalScore)
  ) {
    const score = record.lastEvalScore;
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
