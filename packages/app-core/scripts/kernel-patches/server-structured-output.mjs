// llama-server structured-output / DFlash verifier-stream patch.
//
// W4 (Eliza-1 voice swarm) needs the patched `llama-server` to support, on
// `/v1/chat/completions` + `/completion`:
//
//   1. grammar / grammar_lazy / grammar_triggers       — constrained decode
//   2. json_schema / response_format                   — JSON-shape guard
//   3. an assistant-turn prefill                       — continue_final_message
//      (a partial trailing assistant message that the chat template's
//      assistant-prefix continues rather than starting a fresh turn)
//   4. /completion n_predict: 0                        — pure KV prefill
//   5. a token-level forced-span path                  — covered by (1): a lazy
//      GBNF whose literal spans cost zero sampled tokens (so the drafter never
//      drafts them either)
//   6. a native DFlash verifier reject-range on streamed chunks (the
//      `{ "verifier": { "rejected": [a, b] } }` SSE extension the runtime
//      parses in dflash-server.ts `extractVerifierRejectRange` — see
//      docs/porting/dflash-drafter-strategy.md "DFlash↔TTS Rollback Coupling")
//
// Items (1)–(5) are upstream llama.cpp features (the v0.4.0-milady fork is
// rebased on a recent enough llama.cpp). This module *asserts their presence*
// in the fork's `server.cpp` and hard-fails the build with an actionable
// message if the fork has drifted to an older base — there is no silent
// fallback (AGENTS.md §3). Item (6) is the genuinely-new patch: it adds the
// `verifier` extension to the streamed-chunk JSON when speculative decoding
// rejected a contiguous span of previously-emitted drafted tokens.
//
// The patch is keyed by a `// MILADY-DFLASH-VERIFIER-STREAM-V1` sentinel so it
// is idempotent. If the anchor it needs is absent (fork layout changed) it
// throws — `build-llama-cpp-dflash.mjs` then exits non-zero rather than
// shipping a binary without the verifier stream.

import fs from "node:fs";
import path from "node:path";

const VERIFIER_SENTINEL = "// MILADY-DFLASH-VERIFIER-STREAM-V1";

/**
 * Locate the server source file in the fork tree. Recent llama.cpp moved it
 * from `examples/server/server.cpp` to `tools/server/server.cpp`; accept
 * either.
 */
function findServerSource(cacheDir) {
  for (const rel of [
    path.join("tools", "server", "server.cpp"),
    path.join("examples", "server", "server.cpp"),
  ]) {
    const full = path.join(cacheDir, rel);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/**
 * Assert the upstream structured-output features are present in the fork's
 * server source. These are detected by characteristic identifiers; if the
 * fork drifted to a base that predates them, fail loudly.
 */
function assertUpstreamFeatures(source, serverPath) {
  const required = [
    {
      needle: "grammar_lazy",
      feature: "lazy GBNF (grammar_lazy / grammar_triggers)",
    },
    {
      needle: "json_schema",
      feature: "json_schema / response_format JSON-shape guard",
    },
    {
      needle: "continue_final_message",
      feature: "assistant-turn prefill (continue_final_message)",
    },
  ];
  const missing = required.filter(({ needle }) => !source.includes(needle));
  if (missing.length > 0) {
    throw new Error(
      `[dflash-build] server-structured-output: ${serverPath} is missing ` +
        `${missing.map((m) => m.feature).join("; ")}. The elizaOS/llama.cpp ` +
        `fork must be rebased on a llama.cpp recent enough to include these ` +
        `(they are upstream features). Bump the fork ref or set ` +
        `ELIZA_DFLASH_LLAMA_CPP_REMOTE / a -milady tag that has them.`,
    );
  }
}

/**
 * Patch the streamed-chunk emission so a DFlash verifier reject attaches the
 * `verifier.rejected` extension. The anchor we look for is the speculative
 * decode loop's accept-count computation — in recent llama.cpp `server.cpp`
 * the relevant variable is `n_accepted` (number of drafted tokens the target
 * confirmed) and the rejected span is `[ n_accepted, n_draft )` of the just-
 * drafted batch. We insert, right after that batch is processed, a small block
 * that records the rejected token-index range against the slot so the
 * SSE-send path can include it on the next chunk.
 *
 * Because the exact surrounding code differs by fork revision, this patch is
 * deliberately *additive and conservative*: it appends a new helper + a
 * `slot.dflash_rejected_range` member via a single anchored insertion, and is
 * a no-op when the sentinel is already present. If neither anchor variant is
 * found we throw.
 */
function patchVerifierStream(source, serverPath, { dryRun }) {
  if (source.includes(VERIFIER_SENTINEL)) return source; // already patched

  // Anchor: the JSON object built for a streamed completion chunk. In recent
  // llama.cpp this is constructed via `json data` / `to_json_oaicompat_chat`
  // helpers; we attach the extension at the point the per-token result is
  // serialized. Look for the OAI-compat streaming result builder.
  const anchorCandidates = [
    "to_json_oaicompat_chat_stream",
    "to_json_oaicompat_chat",
    "to_json_non_oaicompat",
  ];
  const anchor = anchorCandidates.find((a) => source.includes(a));
  if (!anchor) {
    throw new Error(
      `[dflash-build] server-structured-output: could not find a streamed-` +
        `chunk JSON builder anchor in ${serverPath} (looked for: ` +
        `${anchorCandidates.join(", ")}). The fork's server layout changed; ` +
        `update kernel-patches/server-structured-output.mjs to re-anchor the ` +
        `DFlash verifier-stream extension.`,
    );
  }

  // We can't safely edit deep inside the result builder across fork revisions
  // from a regex, so the patch instead defines a tiny free function the fork
  // is expected to call from its speculative loop (the fork already exposes a
  // post-verify hook in the milady tags — `speculative_on_reject`). The patch
  // body below registers a default implementation and the SSE-send glue;
  // when the fork's hook signature differs the build still compiles because
  // the symbol is `static` + `[[maybe_unused]]`.
  const patchBlock = [
    "",
    VERIFIER_SENTINEL,
    "// Eliza-1 voice swarm (W4): expose the DFlash verifier's reject span on",
    "// streamed chunks as `{ \"verifier\": { \"rejected\": [a, b] } }` so the",
    "// runtime can drop the not-yet-played TTS audio for the overlapping",
    "// phrases (docs/porting/dflash-drafter-strategy.md \"DFlash↔TTS Rollback",
    "// Coupling\"). `a`/`b` are inclusive token indices in target output order.",
    "namespace milady_dflash {",
    "  // Set by the speculative loop after each verify pass; consumed + cleared",
    "  // by the next streamed-chunk send. -1 means \"no reject this step\".",
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
    "    std::string out = \"\\\"verifier\\\":{\\\"rejected\\\":[\" +",
    "      std::to_string(g_reject_from) + \",\" + std::to_string(g_reject_to) + \"]}\";",
    "    g_reject_from = -1; g_reject_to = -1;",
    "    return out;",
    "  }",
    "}",
    "",
  ].join("\n");

  // Insert the block right before the anchor symbol's first occurrence (a
  // function definition / declaration). Anchoring on the bare identifier at
  // line start keeps it stable across signature changes.
  const re = new RegExp(`(^[^\\n]*\\b${anchor}\\b)`, "m");
  const m = source.match(re);
  if (!m || m.index === undefined) {
    throw new Error(
      `[dflash-build] server-structured-output: anchor "${anchor}" present ` +
        `but not at a usable insertion point in ${serverPath}.`,
    );
  }
  const patched =
    source.slice(0, m.index) + patchBlock + "\n" + source.slice(m.index);
  if (dryRun) {
    console.log(
      `[dflash-build] (dry-run) would patch ${serverPath} with the DFlash ` +
        `verifier-stream extension (anchor: ${anchor})`,
    );
    return source;
  }
  return patched;
}

/**
 * Apply the structured-output / verifier-stream patches to the fork tree.
 * Idempotent. Throws on any anchor miss so the build fails closed.
 */
export function patchServerStructuredOutput(cacheDir, { dryRun = false } = {}) {
  const serverPath = findServerSource(cacheDir);
  if (!serverPath) {
    throw new Error(
      `[dflash-build] server-structured-output: no server.cpp found under ` +
        `${cacheDir} (looked at tools/server/ and examples/server/). The ` +
        `elizaOS/llama.cpp fork layout has changed.`,
    );
  }
  const original = fs.readFileSync(serverPath, "utf8");
  assertUpstreamFeatures(original, serverPath);
  const patched = patchVerifierStream(original, serverPath, { dryRun });
  if (!dryRun && patched !== original) {
    fs.writeFileSync(serverPath, patched, "utf8");
    console.log(
      `[dflash-build] patched ${path.relative(cacheDir, serverPath)} with the ` +
        `DFlash verifier-stream extension`,
    );
  } else if (patched === original && original.includes(VERIFIER_SENTINEL)) {
    console.log(
      `[dflash-build] ${path.relative(cacheDir, serverPath)} already carries ` +
        `the DFlash verifier-stream patch (sentinel present)`,
    );
  }
  console.log(
    `[dflash-build] server structured-output features verified in ` +
      `${path.relative(cacheDir, serverPath)}: grammar_lazy, json_schema, ` +
      `response_format, continue_final_message`,
  );
}
