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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  return value
    .filter((item): item is string => typeof item === "string")
    .map(transform);
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
