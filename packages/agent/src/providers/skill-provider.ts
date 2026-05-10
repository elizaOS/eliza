/**
 * Dynamic skill provider with BM25-lite matching.
 *
 * Replaces the upstream plugin-agent-skills providers that dump ALL skills
 * into every prompt. Instead, builds a lightweight inverted index at startup
 * and scores the user's message + recent context to select only the most
 * relevant skills per turn.
 *
 * Three tiers of injection:
 *   - No match:  1-line footer (~25 tokens)
 *   - Moderate:  Compact top-3 list (~150 tokens)
 *   - Strong:    Full instructions of #1 match, capped at 2000 chars
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  Service,
  State,
} from "@elizaos/core";
import { getRecentMessagesData } from "@elizaos/shared";
import { hasAdminAccess } from "../security/access.ts";

// ── Stopwords ────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "will",
  "can",
  "are",
  "use",
  "when",
  "how",
  "what",
  "your",
  "you",
  "our",
  "has",
  "have",
  "been",
  "not",
  "but",
  "all",
  "also",
  "more",
  "than",
  "into",
  "does",
  "did",
  "was",
  "were",
  "would",
  "could",
  "should",
  "about",
  "just",
  "like",
  "some",
  "other",
  "any",
  "each",
  "make",
  "made",
  "get",
  "set",
  "put",
  "take",
  "see",
  "way",
  "may",
  "then",
  "its",
  "too",
  "very",
  "after",
  "before",
  "between",
  "through",
  "during",
  "here",
  "there",
  "where",
  "which",
  "who",
  "whom",
  "they",
  "them",
  "their",
  "she",
  "her",
  "him",
  "his",
  // Agent/skill noise words
  "skill",
  "agent",
  "search",
  "install",
  "plugin",
  "using",
  "used",
  "help",
  "want",
  "need",
  "please",
]);

// ── Tokenizer ────────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// ── BM25-Lite Index ──────────────────────────────────────────────────────────

interface SkillDoc {
  slug: string;
  name: string;
  description: string;
  triggers: string[];
  tf: Map<string, number>;
  totalTerms: number;
}

interface BM25Index {
  docs: SkillDoc[];
  /** Inverted index: term → set of doc indices */
  postings: Map<string, Set<number>>;
  /** Document frequency: term → number of docs containing it */
  df: Map<string, number>;
  avgDl: number;
  builtAt: number;
  /** Number of skills that were loaded when index was built */
  skillCount: number;
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const INDEX_TTL_MS = 60_000;

function extractTriggers(description: string): string[] {
  const match = description.match(/Use (?:when|for|to)\s+([^.]+)/i);
  if (!match) return [];
  return match[1]
    .split(/[,;]/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

function buildIndex(
  skills: Array<{
    slug: string;
    name: string;
    description: string;
  }>,
): BM25Index {
  const docs: SkillDoc[] = [];
  const postings = new Map<string, Set<number>>();
  const df = new Map<string, number>();
  let totalDl = 0;

  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i];
    const triggers = extractTriggers(skill.description);
    const text = `${skill.name} ${skill.description} ${triggers.join(" ")}`;
    const terms = tokenize(text);

    const tf = new Map<string, number>();
    for (const term of terms) {
      tf.set(term, (tf.get(term) ?? 0) + 1);
    }

    // Also index the slug tokens (e.g. "github" from slug "github")
    for (const slugToken of skill.slug.split(/[-_]/)) {
      if (slugToken.length > 2) {
        const t = slugToken.toLowerCase();
        tf.set(t, (tf.get(t) ?? 0) + 2); // Boost slug terms
      }
    }

    const doc: SkillDoc = {
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      triggers,
      tf,
      totalTerms: terms.length,
    };
    docs.push(doc);
    totalDl += terms.length;

    // Build postings
    for (const term of tf.keys()) {
      let set = postings.get(term);
      if (!set) {
        set = new Set();
        postings.set(term, set);
      }
      set.add(i);
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  return {
    docs,
    postings,
    df,
    avgDl: docs.length > 0 ? totalDl / docs.length : 1,
    builtAt: Date.now(),
    skillCount: skills.length,
  };
}

interface ScoredSkill {
  slug: string;
  name: string;
  description: string;
  score: number;
}

function scoreQuery(index: BM25Index, queryText: string): ScoredSkill[] {
  const queryTerms = tokenize(queryText);
  if (queryTerms.length === 0) return [];

  const N = index.docs.length;
  const scores = new Float64Array(N);

  // BM25 scoring
  for (const term of queryTerms) {
    const docSet = index.postings.get(term);
    if (!docSet) continue;

    const docFreq = index.df.get(term) ?? 0;
    const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);

    for (const docIdx of docSet) {
      const doc = index.docs[docIdx];
      const termFreq = doc.tf.get(term) ?? 0;
      const dlNorm = 1 - BM25_B + BM25_B * (doc.totalTerms / index.avgDl);
      const tfScore =
        (termFreq * (BM25_K1 + 1)) / (termFreq + BM25_K1 * dlNorm);
      scores[docIdx] += idf * tfScore;
    }
  }

  // Exact-match bonuses (catches cases BM25 misses due to tokenization)
  const queryLower = queryText.toLowerCase();
  for (let i = 0; i < N; i++) {
    const doc = index.docs[i];
    if (queryLower.includes(doc.slug.toLowerCase())) scores[i] += 10;
    if (queryLower.includes(doc.name.toLowerCase())) scores[i] += 8;
    for (const trigger of doc.triggers) {
      if (trigger && queryLower.includes(trigger)) scores[i] += 5;
    }
  }

  // Collect and sort
  const results: ScoredSkill[] = [];
  for (let i = 0; i < N; i++) {
    if (scores[i] > 0) {
      const doc = index.docs[i];
      results.push({
        slug: doc.slug,
        name: doc.name,
        description: doc.description,
        score: scores[i],
      });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ── Recent context helper ────────────────────────────────────────────────────

function getRecentContext(state: State): string {
  return getRecentMessagesData(state)
    .slice(-5)
    .map((message) => {
      const content = message.content as Record<string, unknown> | undefined;
      return (content?.text as string) ?? "";
    })
    .join(" ");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncateDesc(desc: string, maxLen: number): string {
  if (desc.length <= maxLen) return desc;
  return `${desc.substring(0, maxLen - 3)}...`;
}

// ── Thresholds ───────────────────────────────────────────────────────────────

const THRESHOLD_RELEVANT = 3;
const THRESHOLD_HIGHLY_RELEVANT = 8;
const MAX_INSTRUCTION_CHARS = 2000;
const MAX_SKILL_MATCHES = 3;

// ── Provider ─────────────────────────────────────────────────────────────────

import type { AgentSkillsServiceLike } from "../types/agent-skills.ts";

export function createDynamicSkillProvider(): Provider {
  let indexCache: BM25Index | null = null;

  return {
    name: "elizaDynamicSkills",
    description:
      "Lightweight dynamic skill matching — injects only relevant skills per turn",
    descriptionCompressed:
      "lightweight dynamic skill match inject relevant skill per turn",
    dynamic: true,
    position: -10,
    contexts: ["general", "agent_internal"],
    contextGate: { anyOf: ["general", "agent_internal"] },
    cacheStable: false,
    cacheScope: "turn",
    roleGate: { minRole: "USER" },

    async get(
      runtime: IAgentRuntime,
      message: Memory,
      state: State,
    ): Promise<ProviderResult> {
      try {
        if (!(await hasAdminAccess(runtime, message))) {
          return { text: "", values: {}, data: {} };
        }

        const service = runtime.getService<Service & AgentSkillsServiceLike>(
          "AGENT_SKILLS_SERVICE",
        );
        if (!service) return { text: "", values: {}, data: {} };

        const skills = service.getLoadedSkills();
        if (skills.length === 0) return { text: "", values: {}, data: {} };

        // Rebuild index if stale or skill count changed
        if (
          !indexCache ||
          Date.now() - indexCache.builtAt > INDEX_TTL_MS ||
          indexCache.skillCount !== skills.length
        ) {
          indexCache = buildIndex(skills);
        }

        // Score against current message + recent context
        const messageText =
          ((message.content as Record<string, unknown>)?.text as string) ?? "";
        const recentContext = getRecentContext(state);
        const queryText = `${messageText} ${recentContext}`;

        const scored = scoreQuery(indexCache, queryText);
        const topMatch = scored[0];

        // Tier 0: No relevant match — 1-line footer only
        if (!topMatch || topMatch.score < THRESHOLD_RELEVANT) {
          return {
            text: `Skills: ${skills.length} installed. Ask "what can you do?" or describe a task to activate relevant skills.`,
            values: { skillMatchTier: "none" as never },
            data: { matchedSkills: [] },
          };
        }

        // Tier 1: Moderate match — compact top-3 list
        const topMatches = scored
          .slice(0, MAX_SKILL_MATCHES)
          .filter((s) => s.score >= THRESHOLD_RELEVANT);
        const compactList = topMatches
          .map(
            (s) =>
              `- **${s.name}** (${s.slug}): ${truncateDesc(s.description, 80)}`,
          )
          .join("\n");

        if (topMatch.score < THRESHOLD_HIGHLY_RELEVANT) {
          return {
            text: `## Relevant Skills\n\n${compactList}\n\n*Use USE_SKILL to invoke one, or SEARCH_SKILLS for more detail.*`,
            values: {
              skillMatchTier: "relevant" as never,
              topSkill: topMatch.slug as never,
            },
            data: {
              matchedSkills: topMatches.map((s) => ({
                slug: s.slug,
                score: s.score,
              })),
            },
          };
        }

        // Tier 2: Strong match — full instructions of #1, capped
        const instructions = service.getSkillInstructions(topMatch.slug);
        let body = "";
        if (instructions?.body) {
          body =
            instructions.body.length > MAX_INSTRUCTION_CHARS
              ? `${instructions.body.substring(0, MAX_INSTRUCTION_CHARS)}\n\n...[truncated — use USE_SKILL for full instructions]`
              : instructions.body;
        }

        const otherMatches =
          topMatches.length > 1
            ? `\n\nAlso relevant: ${topMatches
                .slice(1)
                .map((s) => s.name)
                .join(", ")}`
            : "";

        return {
          text: `## Active Skill: ${topMatch.name}\n\n${body}${otherMatches}`,
          values: {
            skillMatchTier: "active" as never,
            activeSkill: topMatch.slug as never,
            relevanceScore: topMatch.score as never,
          },
          data: {
            activeSkill: { slug: topMatch.slug, score: topMatch.score },
            otherMatches: topMatches
              .slice(1)
              .map((s) => ({ slug: s.slug, score: s.score })),
          },
        };
      } catch (error) {
        return {
          text: "",
          values: { skillMatchTier: "error" as never },
          data: {
            matchedSkills: [],
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  };
}
