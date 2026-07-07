/**
 * Deterministic same-theme rewrite support for scrub stage 3. The production
 * pipeline can swap this pure planner for a model-backed rewriter, but the
 * contract remains the same: keep thread texture while replacing real-world
 * named specifics with stable fictional equivalents and fail if any source
 * value survives the rewrite.
 */
import { createHash } from "node:crypto";
import type { CorpusMessage } from "../schema.ts";

export interface RewriteSurrogate {
  kind: "org" | "project" | "place" | "event";
  source: string;
  replacement: string;
  sourceHash: string;
}

export interface RewritePlan {
  surrogates: RewriteSurrogate[];
}

export interface RewriteResult {
  message: CorpusMessage;
  replacements: RewriteSurrogate[];
}

const ORG_REPLACEMENTS = [
  "Northstar Labs",
  "Harbor Works",
  "Juniper Systems",
  "Beacon Studio",
];
const PROJECT_REPLACEMENTS = [
  "Project Lantern",
  "Project Meridian",
  "Project Orchard",
  "Project Harbor",
];
const PLACE_REPLACEMENTS = ["Riverton", "Lakehaven", "Ashford", "Marin Bay"];
const EVENT_REPLACEMENTS = [
  "Founders Dinner",
  "Spring Showcase",
  "Partner Summit",
  "Launch Social",
];

const ENTITY_PATTERNS: readonly {
  kind: RewriteSurrogate["kind"];
  pattern: RegExp;
  replacements: readonly string[];
}[] = [
  {
    kind: "project",
    pattern: /\bProject [A-Z][a-zA-Z0-9-]{2,}\b/g,
    replacements: PROJECT_REPLACEMENTS,
  },
  {
    kind: "org",
    pattern:
      /\b[A-Z][a-zA-Z0-9-]+ (?:Corp|Corporation|Inc|LLC|Labs|Systems|Studio|Works)\b/g,
    replacements: ORG_REPLACEMENTS,
  },
  {
    kind: "event",
    pattern: /\b[A-Z][a-z]+ (?:Gala|Summit|Retreat|Dinner|Launch|Showcase)\b/g,
    replacements: EVENT_REPLACEMENTS,
  },
  {
    kind: "place",
    pattern: /\b(?:Portland|Austin|Seattle|Chicago|Boston|Denver|Brooklyn)\b/g,
    replacements: PLACE_REPLACEMENTS,
  },
];

function stableHash(value: string, salt: string): string {
  return createHash("sha256").update(`${salt}\0${value}`).digest("hex");
}

function replacementFor(
  source: string,
  salt: string,
  replacements: readonly string[],
): string {
  const hash = stableHash(source, salt);
  const index = Number.parseInt(hash.slice(0, 8), 16) % replacements.length;
  return replacements[index];
}

export function buildRewritePlan(
  messages: readonly CorpusMessage[],
  options: { hashSalt: string },
): RewritePlan {
  const bySource = new Map<string, RewriteSurrogate>();
  for (const message of messages) {
    for (const definition of ENTITY_PATTERNS) {
      definition.pattern.lastIndex = 0;
      for (const match of message.text.matchAll(definition.pattern)) {
        const source = match[0].trim();
        if (source.startsWith("[[SECRET:")) continue;
        if (!bySource.has(source)) {
          bySource.set(source, {
            kind: definition.kind,
            source,
            replacement: replacementFor(
              source,
              options.hashSalt,
              definition.replacements,
            ),
            sourceHash: stableHash(source, options.hashSalt),
          });
        }
      }
    }
  }
  return {
    surrogates: [...bySource.values()].sort((a, b) =>
      a.source.localeCompare(b.source),
    ),
  };
}

export function rewriteSameThemes(
  message: CorpusMessage,
  plan: RewritePlan,
): RewriteResult {
  const replacements = plan.surrogates.filter((surrogate) =>
    message.text.includes(surrogate.source),
  );
  let text = message.text;
  for (const surrogate of [...replacements].sort(
    (a, b) => b.source.length - a.source.length,
  )) {
    text = text.split(surrogate.source).join(surrogate.replacement);
  }
  const leaked = replacements.filter((surrogate) =>
    text.includes(surrogate.source),
  );
  if (leaked.length > 0) {
    throw new Error(
      `rewrite reintroduced source values: ${leaked
        .map((surrogate) => surrogate.sourceHash)
        .join(", ")}`,
    );
  }
  return {
    message: {
      ...message,
      text,
      scrubState: "rewritten",
    },
    replacements,
  };
}
