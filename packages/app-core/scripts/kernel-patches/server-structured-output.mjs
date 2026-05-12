// llama-server structured-output / DFlash verifier-stream patch.
//
// W4 (Eliza-1 voice swarm) wants the patched `llama-server` to support, on
// `/v1/chat/completions` + `/completion`:
//
//   1. grammar / grammar_lazy / grammar_triggers       — constrained decode
//   2. json_schema / response_format                   — JSON-shape guard
//   3. an assistant-turn prefill                       — a partial trailing
//      assistant message that the chat template's assistant-prefix continues
//      rather than starting a fresh turn (upstream llama.cpp implements this
//      via `prefill_assistant` / `prefill_assistant_message`)
//   4. /completion n_predict: 0                        — pure KV prefill
//   5. a token-level forced-span path                  — covered by (1): a lazy
//      GBNF whose literal spans cost zero sampled tokens (so the drafter never
//      drafts them either)
//   6. a native DFlash verifier reject-range on streamed chunks (the
//      `{ "verifier": { "rejected": [a, b] } }` SSE extension the runtime
//      parses in dflash-server.ts `extractVerifierRejectRange` — see
//      docs/porting/dflash-drafter-strategy.md "DFlash↔TTS Rollback Coupling")
//   7. (future fork patch, not yet present) `eliza_prefill_plan` — the
//      guided-structured-decode short-circuit: the request carries the runs of
//      bytes the schema fully determines so the server splices their token ids
//      without a forward pass and advances the decoder to the next free param.
//      Reported (present/absent) like (1)–(4); the runtime sends it whenever
//      guided decode is on and degrades to the grammar-only path when the fork
//      doesn't consume it. See reports/porting/2026-05-11/guided-structured-decoding.md.
//
// Items (1)–(5) are upstream llama.cpp features that the v1.0.0-eliza fork
// already carries (its server source is the post-refactor layout that split
// `tools/server/server.cpp` into `server-task.cpp`, `server-common.cpp`,
// `server-context.cpp`, `server-http.cpp`, …, with `grammar_lazy` /
// `json_schema` / `response_format` / `prefill_assistant`). Structured output
// is NOT on the mandatory-kernel path in AGENTS.md §3 — text, voice, embedding,
// and the DFlash spec loop don't need it — so this module is *tolerant*: it
// logs which of those identifiers it found, warns (does not fail) for any that
// are absent (e.g. while bisecting against an old pinned
// `ELIZA_DFLASH_LLAMA_CPP_REF`), and applies item (6) — the `verifier` SSE
// extension — wherever it can find an anchor.
//
// Item (6) is the genuinely-new patch: it adds the `verifier` extension to the
// streamed-chunk JSON when speculative decoding rejected a contiguous span of
// previously-emitted drafted tokens. It is keyed by a
// `// ELIZA-DFLASH-VERIFIER-STREAM-V1` sentinel so it is idempotent. If no
// usable anchor is present (fork layout changed) it warns and skips rather than
// failing the build — the resulting binary still serves text/voice/embedding
// and the runtime synthesizes accept events from streaming deltas. Note: this
// is a build-time *override* policy, not a "missing kernel" — AGENTS.md §3's
// fail-closed rule covers the TurboQuant/QJL/Polar/DFlash kernels, not the
// optional structured-output HTTP surface.

import fs from "node:fs";
import path from "node:path";

const VERIFIER_SENTINEL = "// ELIZA-DFLASH-VERIFIER-STREAM-V1";

// Server source files in the post-refactor llama.cpp layout, in the order we
// prefer for the verifier-stream anchor (the streamed-chunk JSON builders live
// in `server-task.cpp`). Pre-refactor llama.cpp kept everything in a single
// `tools/server/server.cpp` (or the legacy `examples/server/server.cpp`); both
// are still accepted so a rollback to an older `-eliza` tag keeps working.
const SERVER_SOURCE_RELS = [
  path.join("tools", "server", "server-task.cpp"),
  path.join("tools", "server", "server-task.h"),
  path.join("tools", "server", "server-common.cpp"),
  path.join("tools", "server", "server-common.h"),
  path.join("tools", "server", "server-context.cpp"),
  path.join("tools", "server", "server-context.h"),
  path.join("tools", "server", "server-http.cpp"),
  path.join("tools", "server", "server.cpp"),
  path.join("examples", "server", "server.cpp"),
];

/**
 * Collect the server source files that exist in the fork tree, as
 * `{ rel, full, text }`. Throws only if the fork ships no llama-server source at
 * all (a structural break worth surfacing — this script's whole job is to patch
 * the server).
 */
function collectServerSources(cacheDir) {
  const found = [];
  for (const rel of SERVER_SOURCE_RELS) {
    const full = path.join(cacheDir, rel);
    if (fs.existsSync(full)) {
      found.push({ rel, full, text: fs.readFileSync(full, "utf8") });
    }
  }
  if (found.length === 0) {
    throw new Error(
      `[dflash-build] server-structured-output: no llama-server source found ` +
        `under ${cacheDir} (looked at tools/server/server*.cpp/.h and ` +
        `examples/server/server.cpp). The elizaOS/llama.cpp fork layout has ` +
        `changed; update kernel-patches/server-structured-output.mjs.`,
    );
  }
  return found;
}

// Upstream structured-output identifiers, detected by characteristic tokens.
// Reported (present / absent) but never fatal — see the module header.
const STRUCTURED_OUTPUT_FEATURES = [
  {
    needles: ["grammar_lazy"],
    feature: "lazy GBNF (grammar_lazy / grammar_triggers)",
  },
  {
    needles: ["json_schema"],
    feature: "json_schema JSON-shape guard",
  },
  {
    needles: ["response_format"],
    feature: "response_format object (json_object / json_schema)",
  },
  {
    needles: ["prefill_assistant", "prefill_assistant_message"],
    feature:
      "assistant-turn prefill (prefill_assistant / prefill_assistant_message)",
  },
  {
    // The eliza-harness guided-structured-decode extension: a per-request
    // `eliza_prefill_plan` (the deterministic-token short-circuit — runs of
    // bytes the schema fully determines, which the server can splice as token
    // ids without a forward pass and advance the decoder to the next free
    // param). See structured-output.ts `ElizaPrefillPlan` /
    // reports/porting/2026-05-11/guided-structured-decoding.md. This is an
    // elizaOS-fork extension, not upstream — absent today; when a fork build
    // adds it, the runtime's prefill plan starts saving forward passes. Until
    // then the lazy GBNF still forces the identical bytes, so the runtime is
    // correct either way (it sends the field unconditionally when guided
    // decode is on).
    needles: ["eliza_prefill_plan"],
    feature: "eliza prefill-plan token short-circuit (eliza_prefill_plan)",
  },
];

/**
 * Report which structured-output features the fork's server sources carry. Logs
 * the present set and warns about any absent ones. Does not throw — structured
 * output is an optional HTTP surface, not a mandatory kernel.
 */
function reportStructuredOutputFeatures(sources) {
  const haystack = sources.map((s) => s.text).join("\n");
  const present = [];
  const absent = [];
  for (const { needles, feature } of STRUCTURED_OUTPUT_FEATURES) {
    if (needles.some((n) => haystack.includes(n))) present.push(feature);
    else absent.push(feature);
  }
  if (present.length > 0) {
    console.log(
      `[dflash-build] server structured-output features present: ` +
        `${present.join("; ")}`,
    );
  }
  if (absent.length > 0) {
    console.warn(
      `[dflash-build] ⚠️  server structured-output features absent in the ` +
        `current llama.cpp fork checkout: ${absent.join("; ")}. The fork ` +
        `predates these upstream features — the binary still serves ` +
        `text/voice/embedding + the DFlash spec loop; only the constrained / ` +
        `JSON-shape HTTP surface is unavailable. Bump the fork ref to pick ` +
        `them up if you need it.`,
    );
  }
}

// The free-function namespace we splice in: a `note_reject` / `take_reject_json`
// helper pair the fork's speculative loop calls so a verifier reject attaches
// the `{ "verifier": { "rejected": [a, b] } }` extension to the next streamed
// chunk. Both functions are `[[maybe_unused]]` so the build still compiles when
// the fork's hook signature differs.
const VERIFIER_PATCH_BLOCK = [
  "",
  VERIFIER_SENTINEL,
  "// Eliza-1 voice swarm (W4): expose the DFlash verifier's reject span on",
  '// streamed chunks as `{ "verifier": { "rejected": [a, b] } }` so the',
  "// runtime can drop the not-yet-played TTS audio for the overlapping",
  '// phrases (docs/porting/dflash-drafter-strategy.md "DFlash↔TTS Rollback',
  '// Coupling"). `a`/`b` are inclusive token indices in target output order.',
  "namespace eliza_dflash {",
  "  // Set by the speculative loop after each verify pass; consumed + cleared",
  '  // by the next streamed-chunk send. -1 means "no reject this step".',
  "  static thread_local long long g_reject_from = -1;",
  "  static thread_local long long g_reject_to   = -1;",
  "  [[maybe_unused]] static inline void note_reject(long long from, long long to) {",
  "    if (from < 0 || to < from) { return; }",
  "    g_reject_from = from; g_reject_to = to;",
  "  }",
  "  // Returns the pending reject extension as a JSON fragment string and",
  "  // clears it, or an empty string when there is nothing pending.",
  "  [[maybe_unused]] static inline std::string take_reject_json() {",
  "    if (g_reject_from < 0) { return std::string(); }",
  '    std::string out = "\\"verifier\\":{\\"rejected\\":[" +',
  '      std::to_string(g_reject_from) + "," + std::to_string(g_reject_to) + "]}";',
  "    g_reject_from = -1; g_reject_to = -1;",
  "    return out;",
  "  }",
  "}",
  "",
].join("\n");

// Marker identifiers (the OAI-compat streamed-result builders). In the
// post-refactor layout these are defined in `tools/server/server-task.cpp`; in
// the pre-refactor layout they lived in `server.cpp`. We don't anchor *at* one
// of these (they appear both as `return … ? to_json_oaicompat_chat_stream()`
// calls and as definitions, and a regex can't reliably tell them apart across
// fork revisions) — we just use them to pick the *right* translation unit, then
// splice the free-function namespace at file scope, right after the include /
// `using` preamble.
const VERIFIER_TU_MARKERS = [
  "to_json_oaicompat_chat_stream",
  "to_json_oaicompat_chat",
  "to_json_non_oaicompat",
  "to_json_oaicompat",
];

/**
 * Find the file-scope insertion point for the verifier-stream block in one
 * `.cpp` source: the character offset just after the leading preamble of
 * `#include` / `#pragma` / `using` / `namespace … ;` lines (and blank /
 * single-line-comment lines between them). Returns `{ marker, index }` or null
 * when this TU doesn't contain a streamed-result builder symbol.
 */
function findVerifierTuInsertionPoint(source) {
  const marker = VERIFIER_TU_MARKERS.find((m) => source.includes(m));
  if (!marker) return null;
  const lines = source.split("\n");
  let lastPreambleLineIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (
      t.startsWith("#include") ||
      t.startsWith("#pragma") ||
      t.startsWith("#define") ||
      /^using\b/.test(t) ||
      /^namespace\b[^{]*;$/.test(t)
    ) {
      lastPreambleLineIdx = i;
    } else if (t === "" || t.startsWith("//")) {
    } else {
      break;
    }
  }
  if (lastPreambleLineIdx < 0) return null;
  // Offset = start of the line *after* the last preamble line.
  let index = 0;
  for (let i = 0; i <= lastPreambleLineIdx; i += 1)
    index += lines[i].length + 1;
  return { marker, index };
}

/**
 * Apply the structured-output report + verifier-stream patch to the fork tree.
 * Idempotent. Tolerant: a fork that predates the upstream structured-output
 * features, or whose server layout no longer matches the verifier-stream
 * anchors, gets a warning and the patch is skipped — the build still produces a
 * binary that serves text/voice/embedding + the DFlash spec loop. Throws only
 * if the fork ships no llama-server source at all.
 */
export function patchServerStructuredOutput(cacheDir, { dryRun = false } = {}) {
  const sources = collectServerSources(cacheDir);
  reportStructuredOutputFeatures(sources);

  if (sources.some((s) => s.text.includes(VERIFIER_SENTINEL))) {
    console.log(
      `[dflash-build] llama-server sources already carry the DFlash ` +
        `verifier-stream patch (sentinel present)`,
    );
    return;
  }

  // Only a `.cpp` translation unit can host the free-function namespace (a
  // header would pull it into every TU). Pick the first `.cpp` (in
  // SERVER_SOURCE_RELS order) that contains a streamed-result builder symbol,
  // then splice the block at file scope right after that file's include /
  // `using` preamble.
  let target = null;
  for (const src of sources) {
    if (!src.rel.endsWith(".cpp")) continue;
    const found = findVerifierTuInsertionPoint(src.text);
    if (found) {
      target = { ...src, ...found };
      break;
    }
  }
  if (!target) {
    const where = sources.map((s) => s.rel).join(", ");
    console.warn(
      `[dflash-build] ⚠️  server-structured-output: no llama-server ` +
        `translation unit (.cpp) with a streamed-result builder ` +
        `(${VERIFIER_TU_MARKERS.join(" / ")}) + a recognizable include/using ` +
        `preamble found in ${where}. Skipping the DFlash verifier-stream ` +
        `extension — the runtime falls back to synthesizing accept events ` +
        `from streaming deltas. Update kernel-patches/server-structured-output.mjs ` +
        `if the native reject range is needed.`,
    );
    return;
  }
  if (dryRun) {
    console.log(
      `[dflash-build] (dry-run) would patch ${target.rel} with the DFlash ` +
        `verifier-stream extension (TU marker: ${target.marker})`,
    );
    return;
  }
  const patched =
    target.text.slice(0, target.index) +
    VERIFIER_PATCH_BLOCK +
    "\n" +
    target.text.slice(target.index);
  fs.writeFileSync(target.full, patched, "utf8");
  console.log(
    `[dflash-build] patched ${target.rel} with the DFlash verifier-stream ` +
      `extension (TU marker: ${target.marker})`,
  );
}
