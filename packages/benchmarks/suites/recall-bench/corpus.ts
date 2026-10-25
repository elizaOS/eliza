/**
 * recall-bench — deterministic, labelled, document-scale corpus (#9956).
 *
 * A retrieval benchmark needs (a) documents ingested through the REAL
 * `DocumentService`, and (b) a query set with ground-truth *relevant document
 * ids*. Labelling at the **document** level (not fragment) is deliberate: the
 * real ingestion chunks a document into fragments with service-assigned ids we
 * don't control, so the bench resolves each retrieved fragment back to its
 * `documentId` and scores against the labelled doc set.
 *
 * Construction (seeded, reproducible): `topics` distinct subjects, each pinned
 * to a unique English **root** + numeric tag so topics never share vocabulary.
 * Per topic there are three doc classes (see TIERS below): *relevant* answers
 * (the topic's base token + extra same-root forms), *confusable* distractors
 * (the same base token but a foreign body — keyword-indistinguishable from
 * relevant, yet vector-distant), and *noise* (disjoint roots, no query token).
 * Keyword/BM25 cannot separate relevant from confusable (their only query
 * overlap is the shared base token), but the bench embedding ranks the
 * confusables out — so the **vector path out-recalls keyword on the same
 * corpus**, which is what makes the embed fail-open a *measurable* recall drop
 * rather than a silent one. Shared English filler is sprinkled in as noise.
 */

/** A corpus document (ingested whole; the service chunks it into fragments). */
export interface CorpusDoc {
  id: string;
  text: string;
  topic: number;
}

/** A query with its ground-truth relevant document ids. */
export interface CorpusQuery {
  id: string;
  text: string;
  topic: number;
  relevantDocIds: string[];
}

export interface Corpus {
  tier: string;
  topics: number;
  docs: CorpusDoc[];
  queries: CorpusQuery[];
}

export type CorpusTier = "smoke" | "1k" | "10k";

/**
 * A labelled fact for the FACTS-provider slice. The provider retrieves from the
 * `facts` table by keyword + recency (no vectors), so each fact carries the
 * `keywords` the provider ranks on. Exactly one fact is relevant to each query
 * (`relevantQueryId`); the rest are distractors drawn from unused roots, so the
 * pool exceeds the provider's top-K and ranking is actually exercised.
 */
export interface FactItem {
  id: string;
  text: string;
  keywords: string[];
  kind: "durable" | "current";
  relevantQueryId?: string;
}

const FACT_DISTRACTORS = 30;

/**
 * Build the facts corpus for a tier: one durable fact answering each query
 * (keyworded on that query's exact tokens) plus `FACT_DISTRACTORS` durable
 * distractors on roots the document corpus never uses (disjoint tokens → they
 * score ~0 and must be ranked out). Deterministic given the tier.
 */
export function buildFacts(tier: CorpusTier): FactItem[] {
  const { topics } = TIERS[tier];
  const facts: FactItem[] = [];

  for (let t = 0; t < topics; t++) {
    const root = ROOTS[t % ROOTS.length];
    facts.push({
      id: `fact-${t}`,
      // Keyworded on the query's two tokens so the real BM25 ranker surfaces it.
      keywords: [`${root}${t}`, queryForm(root, t)],
      text: `the user configured the ${root}${t} subsystem and relies on ${queryForm(root, t)}`,
      kind: "durable",
      relevantQueryId: `q-${t}`,
    });
  }

  // Distractors: roots beyond the document corpus's topic span → no token
  // overlap with any query, so the ranker must keep them out of the top-K.
  for (let d = 0; d < FACT_DISTRACTORS; d++) {
    const idx = topics + d;
    const root = ROOTS[idx % ROOTS.length];
    facts.push({
      id: `fact-distractor-${d}`,
      keywords: [`${root}${idx}`, queryForm(root, idx)],
      text: `the user noted the ${root}${idx} subsystem in passing`,
      kind: "durable",
    });
  }

  return facts;
}

// Each query has a small fixed relevant set (so Recall@5 spans [0,1]); scale
// comes from *distractor* docs, NOT from more relevant docs or more topics.
// Topics stay ≤ TOPIC_ROOT_COUNT so every topic gets a UNIQUE root — reusing a
// root across topics would let the vector path's subword (root-trigram) signal
// bleed between same-root topics and erase its edge over keyword.
//
// Three doc classes per corpus:
//  - relevant     — the topic's ground-truth answers; every one carries the
//                   query's exact base token AND extra same-root forms (rich
//                   root-trigram mass) → both keyword and vector retrieve them.
//  - confusable   — carry the topic's exact base token but a FOREIGN body
//                   (disjoint roots). Keyword/BM25 can't tell them from relevant
//                   (same query-overlapping tokens), but their vector embedding
//                   sits far from the query. So pure-keyword pollutes its top-K
//                   with these while the vector path ranks them out — which is
//                   exactly what makes the embed fail-open a *measurable* drop.
//  - noise        — disjoint roots, no query token at all; pad to document scale.
const TIERS: Record<
  CorpusTier,
  {
    topics: number;
    relevantPerTopic: number;
    confusablePerTopic: number;
    totalDocs: number;
  }
> = {
  // 18 rel + 30 confusable + 12 noise = 60
  smoke: {
    topics: 6,
    relevantPerTopic: 3,
    confusablePerTopic: 5,
    totalDocs: 60,
  },
  // 200 rel + 200 confusable + 600 noise = 1,000
  "1k": {
    topics: 40,
    relevantPerTopic: 5,
    confusablePerTopic: 5,
    totalDocs: 1000,
  },
  // 200 rel + 200 confusable + 9,600 noise = 10,000
  "10k": {
    topics: 40,
    relevantPerTopic: 5,
    confusablePerTopic: 5,
    totalDocs: 10000,
  },
};

/** Real English roots; each topic pins one + a numeric tag for uniqueness. */
const ROOTS = [
  "configure",
  "retrieve",
  "embed",
  "cluster",
  "schema",
  "query",
  "index",
  "memory",
  "vector",
  "document",
  "fragment",
  "rank",
  "search",
  "ingest",
  "encode",
  "decode",
  "compress",
  "validate",
  "migrate",
  "replicate",
  "authenticate",
  "authorize",
  "serialize",
  "normalize",
  "tokenize",
  "aggregate",
  "partition",
  "cache",
  "stream",
  "buffer",
  "compile",
  "deploy",
  "monitor",
  "profile",
  "benchmark",
  "optimize",
  "schedule",
  "dispatch",
  "render",
  "navigate",
  "annotate",
  "summarize",
  "translate",
  "classify",
  "predict",
  "calibrate",
  "synthesize",
  "orchestrate",
  "provision",
  "federate",
];

// The first TOPIC_ROOT_COUNT roots back the topics (one unique root per topic);
// the remainder back distractor docs. The two pools are disjoint, so a query's
// root never trigram-matches a distractor — distractors are pure noise.
const TOPIC_ROOT_COUNT = 40;
const DISTRACTOR_ROOTS = ROOTS.slice(TOPIC_ROOT_COUNT);

/** Morphological forms a topic's *documents* use. */
function docForms(root: string, tag: number): string[] {
  return [
    `${root}${tag}`,
    `${root}d${tag}`,
    `${root}s${tag}`,
    `re${root}${tag}`,
    `${root}ation${tag}`,
  ];
}

/** A form the topic's *query* uses — absent from docForms (subword-only match). */
function queryForm(root: string, tag: number): string {
  return `${root}ing${tag}`;
}

const FILLER = [
  "the",
  "agent",
  "should",
  "handle",
  "this",
  "case",
  "when",
  "the",
  "system",
  "processes",
  "incoming",
  "requests",
  "and",
  "stores",
  "results",
  "for",
  "later",
  "retrieval",
  "across",
  "many",
  "rooms",
  "over",
  "time",
  "reliably",
];

/** Tiny deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(arr: readonly T[], rnd: () => number): T {
  return arr[Math.floor(rnd() * arr.length)];
}

/** A doc built from a few explicit tokens + a little filler. */
function buildDoc(
  id: string,
  topic: number,
  tokens: string[],
  rnd: () => number,
): CorpusDoc {
  return {
    id,
    topic,
    text: [pick(FILLER, rnd), ...tokens, pick(FILLER, rnd)].join(" "),
  };
}

/** A foreign two-token body from the disjoint distractor roots (no query root). */
function foreignBody(seed: number, rnd: () => number): string[] {
  const a = DISTRACTOR_ROOTS[seed % DISTRACTOR_ROOTS.length];
  const b = DISTRACTOR_ROOTS[(seed + 1) % DISTRACTOR_ROOTS.length];
  return [
    pick(docForms(a, 1000 + seed), rnd),
    pick(docForms(b, 2000 + seed), rnd),
  ];
}

/** Build the labelled corpus for a tier. Deterministic given the tier. */
export function buildCorpus(tier: CorpusTier): Corpus {
  const { topics, relevantPerTopic, confusablePerTopic, totalDocs } =
    TIERS[tier];
  if (topics > TOPIC_ROOT_COUNT) {
    throw new Error(
      `recall-bench: topics ${topics} exceeds unique topic roots ${TOPIC_ROOT_COUNT}`,
    );
  }
  const rnd = mulberry32(0x9956 + topics * 131 + totalDocs);
  const docs: CorpusDoc[] = [];
  const queries: CorpusQuery[] = [];

  for (let t = 0; t < topics; t++) {
    const root = ROOTS[t]; // unique per topic — no cross-topic subword bleed
    const tag = t;
    const base = `${root}${tag}`;
    const forms = docForms(root, tag);
    const relevantDocIds: string[] = [];

    // Relevant: the base token (so keyword + vector both retrieve them) plus two
    // more same-root forms (extra trigram mass the vector path rides to outrank
    // the confusables — whose only shared token with the query is `base`).
    for (let d = 0; d < relevantPerTopic; d++) {
      const id = `doc-${t}-${d}`;
      relevantDocIds.push(id);
      docs.push(
        buildDoc(id, t, [base, pick(forms, rnd), pick(forms, rnd)], rnd),
      );
    }

    // Confusable: same base token, foreign body → keyword-indistinguishable from
    // relevant, vector-distant. These are what a healthy vector pass ranks out
    // and a fail-open keyword pass lets pollute the top-K.
    for (let c = 0; c < confusablePerTopic; c++) {
      docs.push(
        buildDoc(
          `confuse-${t}-${c}`,
          -1,
          [base, ...foreignBody(t * 97 + c, rnd)],
          rnd,
        ),
      );
    }

    queries.push({
      id: `q-${t}`,
      topic: t,
      relevantDocIds,
      // base form (exact token shared by relevant AND confusable → keyword can't
      // separate them) + the `-ing` form (in no doc; only the vector path's
      // subword signal binds it) + one filler word.
      text: `${base} ${queryForm(root, tag)} ${pick(FILLER, rnd)}`,
    });
  }

  // Noise: disjoint roots, no query token at all — pure padding to document
  // scale that every healthy mode must rank out.
  const placed = topics * (relevantPerTopic + confusablePerTopic);
  for (let i = 0; i < totalDocs - placed; i++) {
    const root = DISTRACTOR_ROOTS[i % DISTRACTOR_ROOTS.length];
    const tag = 5000 + i; // unique, never equal to a query tag
    const forms = docForms(root, tag);
    docs.push(
      buildDoc(
        `noise-${i}`,
        -1,
        [forms[0], pick(forms, rnd), pick(forms, rnd)],
        rnd,
      ),
    );
  }

  return { tier, topics, docs, queries };
}

// ── morphology slice (proves keyword stemming, #9956 follow-up) ────────────────
//
// The main corpus tags every token with a number (`configure0`), which defeats
// Porter (its suffix rules need a real letter-ending), so it CANNOT measure a
// stemming improvement. This slice uses real English inflectional families with
// NO tags: each query is the family's `-ing` form, which is ABSENT from every
// document — but stems to the same root as the doc forms. So exact-token BM25
// (unstemmed) matches nothing and a Porter-stemmed BM25 matches the family's
// docs. The lift is produced purely by rule-based stemming (a keyword technique),
// not by any semantic/vector signal. Families are stem-verified + collision-free
// (see the offline check in the PR; every `-ing` query stems to its docs' stem
// and the 10 stems are mutually disjoint).

export interface MorphologyCorpus {
  docs: Array<{ id: string; text: string }>;
  queries: Array<{ id: string; text: string; relevantDocIds: string[] }>;
}

/** [naturalQueryWord (-ing, absent from docs), [doc forms that share its stem]] */
const MORPHOLOGY_FAMILIES: ReadonlyArray<readonly [string, readonly string[]]> =
  [
    ["configuring", ["configuration", "configured", "configures"]],
    ["optimizing", ["optimization", "optimized", "optimizes"]],
    ["compressing", ["compression", "compressed", "compresses"]],
    ["validating", ["validation", "validated", "validates"]],
    ["deploying", ["deployment", "deployed", "deploys"]],
    ["scheduling", ["scheduled", "schedules", "scheduler"]],
    ["filtering", ["filtered", "filters", "filterable"]],
    ["rendering", ["rendered", "renders", "renderer"]],
    ["publishing", ["published", "publishes", "publisher"]],
    ["encrypting", ["encryption", "encrypted", "encrypts"]],
  ];

const MORPH_FILLER = [
  "the",
  "system",
  "for",
  "our",
  "this",
  "service",
  "today",
  "again",
  "please",
  "now",
];
const MORPH_RELEVANT_PER_FAMILY = 4;

/**
 * Build the morphology slice. Deterministic. Each family's docs carry two of its
 * doc forms (never the query's `-ing` form); other families are mutual
 * distractors (disjoint stems). Recall is labelled at the doc level.
 */
export function buildMorphologyCorpus(): MorphologyCorpus {
  const rnd = mulberry32(0x9956 + 0x4d52); // "MR"
  const docs: MorphologyCorpus["docs"] = [];
  const queries: MorphologyCorpus["queries"] = [];

  MORPHOLOGY_FAMILIES.forEach(([query, forms], t) => {
    const relevantDocIds: string[] = [];
    for (let d = 0; d < MORPH_RELEVANT_PER_FAMILY; d++) {
      const id = `m-${t}-${d}`;
      relevantDocIds.push(id);
      const f1 = forms[d % forms.length];
      const f2 = forms[(d + 1) % forms.length];
      docs.push({
        id,
        text: [pick(MORPH_FILLER, rnd), f1, f2, pick(MORPH_FILLER, rnd)].join(
          " ",
        ),
      });
    }
    queries.push({
      id: `mq-${t}`,
      text: `${query} ${pick(MORPH_FILLER, rnd)}`,
      relevantDocIds,
    });
  });

  return { docs, queries };
}
