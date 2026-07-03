/**
 * Fused-lib product-path proof harness for the gemma4-assistant MTP drafter.
 *
 * Drives the EXACT desktop text path: libelizainference.dylib ABI-v9
 * `eliza_inference_llm_stream_open` with `mtp_drafter_path` set (the
 * separate-drafter MTP engine, ctx_other shared-KV), via the plugin's own
 * `loadElizaInferenceFfi` binding — no mocks, no llama-server.
 *
 * Target : /tmp/vision/gemma4/bundles/2b/text/eliza-1-2b-128k.gguf (gemma4)
 * Drafter: /tmp/mtp/bundles/2b/mtp/drafter-2b.gguf (gemma4-assistant)
 */
import { loadElizaInferenceFfi } from "/Users/shawwalters/eliza-workspace/eliza/eliza/plugins/plugin-local-inference/src/services/voice/ffi-bindings";

const LIB =
	"/Users/shawwalters/eliza-workspace/eliza/eliza/plugins/plugin-local-inference/native/llama.cpp/build-desktop-metal/bin/libelizainference.dylib";
const BUNDLE_ROOT = "/tmp/vision/gemma4/bundles/2b";
const DRAFTER = "/tmp/mtp/bundles/2b/mtp/drafter-2b.gguf";
const MAX_TOKENS = 96;

const PROMPTS = [
	"Count from one to twenty, writing each number as a word separated by commas.",
	"List the seven days of the week in order, one per line.",
];

function gemmaPrompt(user: string): string {
	return `<start_of_turn>user\n${user}<end_of_turn>\n<start_of_turn>model\n`;
}

const ffi = loadElizaInferenceFfi(LIB);
console.log(`[harness] lib=${LIB}`);
console.log(
	`[harness] abi=${ffi.abiVersion?.() ?? "?"} llmStreamSupported=${ffi.llmStreamSupported?.()} llmMtpSupported=${ffi.llmMtpSupported?.()} tokenizeSupported=${ffi.tokenizeSupported?.()}`,
);

const ctx = ffi.create(BUNDLE_ROOT);
console.log(`[harness] fused ctx created over bundle root ${BUNDLE_ROOT}`);

interface RunResult {
	text: string;
	nGenerated: number;
	ms: number;
	drafted: number;
	accepted: number;
}

function run(user: string, mtp: boolean): RunResult {
	const tokens = ffi.tokenize({ ctx, text: gemmaPrompt(user) });
	const stream = ffi.llmStreamOpen({
		ctx,
		config: {
			maxTokens: MAX_TOKENS,
			temperature: 0, // greedy so baseline and MTP outputs must match
			topP: 1,
			topK: 0,
			repeatPenalty: 1,
			slotId: -1,
			promptCacheKey: null,
			draftMin: mtp ? 1 : 0,
			draftMax: mtp ? 1 : 0,
			draftModelPath: mtp ? DRAFTER : null,
			gpuLayers: -1,
			contextSize: 4096,
		},
	});
	let text = "";
	let nGenerated = 0;
	let drafted = 0;
	let accepted = 0;
	const t0 = performance.now();
	try {
		ffi.llmStreamPrefill({ stream, tokens });
		for (;;) {
			const step = ffi.llmStreamNext({ stream, maxTokensPerStep: 32 });
			text += step.text;
			nGenerated += step.tokens.length;
			drafted += step.drafterDrafted;
			accepted += step.drafterAccepted;
			if (step.done || nGenerated >= MAX_TOKENS) break;
		}
	} finally {
		ffi.llmStreamClose({ stream });
	}
	const ms = performance.now() - t0;
	return { text, nGenerated, ms, drafted, accepted };
}

let totDrafted = 0;
let totAccepted = 0;
for (const p of PROMPTS) {
	console.log(`\n=== prompt: ${JSON.stringify(p)}`);
	const base = run(p, false);
	console.log(
		`[baseline] n=${base.nGenerated} ${(base.nGenerated / (base.ms / 1000)).toFixed(1)} tok/s (prefill+decode ${base.ms.toFixed(0)}ms)`,
	);
	console.log(`[baseline] text: ${JSON.stringify(base.text)}`);
	const mtp = run(p, true);
	totDrafted += mtp.drafted;
	totAccepted += mtp.accepted;
	console.log(
		`[mtp]      n=${mtp.nGenerated} ${(mtp.nGenerated / (mtp.ms / 1000)).toFixed(1)} tok/s (prefill+decode ${mtp.ms.toFixed(0)}ms) drafted=${mtp.drafted} accepted=${mtp.accepted} acceptance=${mtp.drafted > 0 ? (mtp.accepted / mtp.drafted).toFixed(3) : "n/a"}`,
	);
	console.log(`[mtp]      text: ${JSON.stringify(mtp.text)}`);
	console.log(
		`[check]    greedy outputs identical: ${mtp.text === base.text}`,
	);
}

console.log(
	`\n[TOTAL] drafted=${totDrafted} accepted=${totAccepted} acceptance=${totDrafted > 0 ? (totAccepted / totDrafted).toFixed(3) : "n/a"}`,
);

ffi.destroy(ctx);
ffi.close();
console.log("[harness] clean shutdown");
