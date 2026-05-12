// llama-server structured-output / DFlash verifier-stream patch.
//
// W4 (Eliza-1 voice swarm) needs the patched `llama-server` to support, on
// `/v1/chat/completions` + `/completion`:
//
//   1. grammar / grammar_lazy / grammar_triggers       — constrained decode
//   2. json_schema / response_format                   — JSON-shape guard
//   3. an assistant-turn prefill                       — a partial trailing
//      assistant message that the chat template's assistant-prefix continues
//      rather than starting a fresh turn (upstream llama.cpp implements this
//      via `prefill_assistant` / `prefill_assistant_message` — there is no
//      `continue_final_message` identifier in upstream)
//   4. /completion n_predict: 0                        — pure KV prefill
//   5. a token-level forced-span path                  — covered by (1): a lazy
//      GBNF whose literal spans cost zero sampled tokens (so the drafter never
//      drafts them either)
//   6. a native DFlash verifier reject-range on streamed chunks (the
//      `{ "verifier": { "rejected": [a, b] } }` SSE extension the runtime
//      parses in dflash-server.ts `extractVerifierRejectRange` — see
//      docs/porting/dflash-drafter-strategy.md "DFlash↔TTS Rollback Coupling")
//
// Items (1)–(5) are upstream llama.cpp features (the v1.0.0-eliza fork is
// rebased on a recent enough llama.cpp — the server source is the post-refactor
// layout that split `tools/server/server.cpp` into `server-task.cpp`,
// `server-common.cpp`, `server-context.cpp`, `server-http.cpp`, …). This module
// *asserts their presence* across the fork's `tools/server/server*.cpp`/`.h`
// sources and hard-fails the build with an actionable message if the fork has
// drifted to an older base — there is no silent fallback (AGENTS.md §3). Item
// (6) is the genuinely-new patch: it adds the `verifier` extension to the
// streamed-chunk JSON when speculative decoding rejected a contiguous span of
// previously-emitted drafted tokens.
//
// The patch is keyed by a `// ELIZA-DFLASH-VERIFIER-STREAM-V1` sentinel so it
// is idempotent. If the anchor it needs is absent (fork layout changed) it
// throws — `build-llama-cpp-dflash.mjs` then exits non-zero rather than
// shipping a binary without the verifier stream.

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
 * `{ rel, full, text }`. Throws if none are found.
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

/**
 * Assert the upstream structured-output features are present *somewhere* in the
 * fork's server sources. These are detected by characteristic identifiers; if
 * the fork drifted to a base that predates them, fail loudly.
 */
function assertUpstreamFeatures(sources) {
  const required = [
    {
      // grammar_lazy + grammar_triggers — lazy GBNF constrained decode.
      needles: ["grammar_lazy"],
      feature: "lazy GBNF (grammar_lazy / grammar_triggers)",
    },
    {
      // json_schema (under response_format or as a top-level field).
      needles: ["json_schema"],
      feature: "json_schema JSON-shape guard",
    },
    {
      // OpenAI-compat response_format object.
      needles: ["response_format"],
      feature: "response_format object (json_object / json_schema)",
    },
    {
      // Assistant-turn prefill: upstream spells it `prefill_assistant` /
      // `prefill_assistant_message`. (`continue_final_message` is *not* an
      // upstream identifier — it is an OpenAI request field name only.)
      needles: ["prefill_assistant", "prefill_assistant_message"],
      feature:
        "assistant-turn prefill (prefill_assistant / prefill_assistant_message)",
    },
  ];
  const haystack = sources.map((s) => s.text).join("\n");
  const missing = required.filter(
    ({ needles }) => !needles.some((n) => haystack.includes(n)),
  );
  if (missing.length > 0) {
    const where = sources.map((s) => s.rel).join(", ");
    throw new Error(
      `[dflash-build] server-structured-output: the llama-server sources ` +
        `(${where}) are missing ${missing.map((m) => m.feature).join("; ")}. ` +
        `The elizaOS/llama.cpp fork must be rebased on a llama.cpp recent ` +
        `enough to include these (they are upstream features). Bump the fork ` +
        `ref or set ELIZA_DFLASH_LLAMA_CPP_REMOTE / a -eliza tag that has them.`,
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
      // tolerate blank lines / line comments inside the preamble
      continue;
    } else {
      break;
    }
  }
  if (lastPreambleLineIdx < 0) return null;
  // Offset = start of the line *after* the last preamble line.
  let index = 0;
  for (let i = 0; i <= lastPreambleLineIdx; i += 1) index += lines[i].length + 1;
  return { marker, index };
}

/**
 * Apply the structured-output / verifier-stream patches to the fork tree.
 * Idempotent. Throws if the upstream features are absent or no usable anchor for
 * the verifier-stream extension is found (so the build fails closed).
 */
export function patchServerStructuredOutput(cacheDir, { dryRun = false } = {}) {
  const sources = collectServerSources(cacheDir);
  assertUpstreamFeatures(sources);

  if (sources.some((s) => s.text.includes(VERIFIER_SENTINEL))) {
    console.log(
      `[dflash-build] llama-server sources already carry the DFlash ` +
        `verifier-stream patch (sentinel present)`,
    );
  } else {
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
      throw new Error(
        `[dflash-build] server-structured-output: could not find a llama-server ` +
          `translation unit (.cpp) containing a streamed-result builder ` +
          `(${VERIFIER_TU_MARKERS.join(" / ")}) with a recognizable include/using ` +
          `preamble in any of ${where}. The fork's server layout changed; update ` +
          `kernel-patches/server-structured-output.mjs to re-anchor the DFlash ` +
          `verifier-stream extension.`,
      );
    }
    if (dryRun) {
      console.log(
        `[dflash-build] (dry-run) would patch ${target.rel} with the DFlash ` +
          `verifier-stream extension (TU marker: ${target.marker})`,
      );
    } else {
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
  }

  console.log(
    `[dflash-build] server structured-output features verified across ` +
      `${sources.map((s) => s.rel).join(", ")}: grammar_lazy, json_schema, ` +
      `response_format, prefill_assistant`,
  );
}
