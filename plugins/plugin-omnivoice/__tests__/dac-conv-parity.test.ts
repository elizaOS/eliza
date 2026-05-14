/**
 * Numerical parity harness for the `dac_conv_t1d` migration tracked in
 * elizaOS/eliza GitHub issue #7660.
 *
 * Background:
 *   elizaOS/llama.cpp@78c4fb190 collapsed the 5-step `dac_conv_t1d()`
 *   body into a single `ggml_conv_transpose_1d()` call. Compile + shape
 *   semantics were verified at merge time; numerical parity was NOT.
 *
 *   This test compares the current binary's synthesis output against a
 *   pre-captured baseline PCM file. The baseline must be captured ONCE,
 *   from a pre-merge build (any commit before 79079c25e on
 *   elizaOS/omnivoice.cpp), using:
 *
 *     bun plugins/plugin-omnivoice/scripts/capture-dac-baseline.mjs
 *
 *   See that script's header for the full capture workflow.
 *
 * Skip contract:
 *   The test SKIPS (does not fail) when any of these are missing:
 *     - OMNIVOICE_MODEL_PATH (speech GGUF) is unset or points at a missing file
 *     - OMNIVOICE_CODEC_PATH (DAC codec GGUF) is unset or points at a missing file
 *     - the baseline fixture file is absent
 *   The skip messages identify which input is missing so CI doesn't fail
 *   silently and a developer can capture the missing fixture.
 *
 * Tolerance:
 *   MSE between the new and baseline Float32 samples must be < 1e-5.
 *   The same tolerance is used by the omnivoice.cpp upstream sanity
 *   probes (see omnivoice.cpp/tests/test-conv-transpose-1d.cpp).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, "__fixtures__", "dac");

/** Canonical fixed-input test vector. Keep in sync with capture-dac-baseline.mjs. */
const PARITY_FIXTURE = {
	name: "dac-parity-en-fixed",
	text: "The quick brown fox jumps over the lazy dog.",
	lang: "en" as const,
	instruct: "female adult moderate narration moderate neutral",
	/**
	 * MaskGit seed locks the generator's stochastic path so a fixed input
	 * produces a deterministic Float32 PCM output across runs.
	 */
	seed: 7660n,
};

const MSE_TOLERANCE = 1e-5;

interface DacBaselineHeader {
	readonly magic: "DACPCM01";
	readonly sampleRate: number;
	readonly channels: number;
	readonly numSamples: number;
}

interface DacBaseline {
	readonly header: DacBaselineHeader;
	readonly samples: Float32Array;
}

/**
 * Parse the on-disk baseline file written by capture-dac-baseline.mjs.
 *
 * Layout (little-endian):
 *   bytes  0..  7   magic 'DACPCM01'   (8 bytes ASCII)
 *   bytes  8.. 11   sample_rate         (u32)
 *   bytes 12.. 15   channels            (u32)
 *   bytes 16.. 23   num_samples         (u64)
 *   bytes 24..  N   float32 samples     (num_samples * 4 bytes)
 */
function parseBaseline(buf: Buffer): DacBaseline {
	if (buf.byteLength < 24) {
		throw new Error(
			`dac-conv-parity: baseline file too short (${buf.byteLength} bytes < 24-byte header)`,
		);
	}
	const magic = buf.toString("ascii", 0, 8);
	if (magic !== "DACPCM01") {
		throw new Error(
			`dac-conv-parity: bad baseline magic '${magic}' — expected 'DACPCM01'`,
		);
	}
	const sampleRate = buf.readUInt32LE(8);
	const channels = buf.readUInt32LE(12);
	const numSamplesBig = buf.readBigUInt64LE(16);
	if (numSamplesBig > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error("dac-conv-parity: baseline declares too many samples");
	}
	const numSamples = Number(numSamplesBig);
	const expectedBytes = 24 + numSamples * 4;
	if (buf.byteLength !== expectedBytes) {
		throw new Error(
			`dac-conv-parity: baseline payload length mismatch (have ${buf.byteLength}, want ${expectedBytes})`,
		);
	}
	const samples = new Float32Array(
		buf.buffer.slice(buf.byteOffset + 24, buf.byteOffset + expectedBytes),
	);
	return {
		header: { magic: "DACPCM01", sampleRate, channels, numSamples },
		samples,
	};
}

function computeMse(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length) {
		throw new Error(
			`dac-conv-parity: length mismatch — current=${a.length} baseline=${b.length}`,
		);
	}
	if (a.length === 0) {
		throw new Error("dac-conv-parity: empty samples");
	}
	let acc = 0;
	for (let i = 0; i < a.length; i += 1) {
		const d = a[i] - b[i];
		acc += d * d;
	}
	return acc / a.length;
}

interface SkipReason {
	readonly reason: string;
}

interface ReadyInputs {
	readonly modelPath: string;
	readonly codecPath: string;
	readonly baselinePath: string;
	readonly baseline: DacBaseline;
}

function resolveInputs(): SkipReason | ReadyInputs {
	const modelPath = process.env.OMNIVOICE_MODEL_PATH?.trim() ?? "";
	const codecPath = process.env.OMNIVOICE_CODEC_PATH?.trim() ?? "";
	const baselineOverride = process.env.OMNIVOICE_DAC_BASELINE?.trim() ?? "";
	const baselinePath =
		baselineOverride !== ""
			? baselineOverride
			: path.join(FIXTURE_DIR, `${PARITY_FIXTURE.name}.dacpcm`);

	if (modelPath === "") {
		return {
			reason: "OMNIVOICE_MODEL_PATH is unset — skipping #7660 DAC parity check",
		};
	}
	if (!existsSync(modelPath)) {
		return {
			reason: `OMNIVOICE_MODEL_PATH does not exist: ${modelPath}`,
		};
	}
	if (codecPath === "") {
		return {
			reason: "OMNIVOICE_CODEC_PATH is unset — skipping #7660 DAC parity check",
		};
	}
	if (!existsSync(codecPath)) {
		return {
			reason: `OMNIVOICE_CODEC_PATH does not exist: ${codecPath}`,
		};
	}
	if (!existsSync(baselinePath)) {
		return {
			reason:
				`baseline file missing at ${baselinePath} — capture it first via ` +
				"plugins/plugin-omnivoice/scripts/capture-dac-baseline.mjs " +
				"(see script header for the pre-merge build workflow)",
		};
	}
	const buf = readFileSync(baselinePath);
	const baseline = parseBaseline(buf);
	return { modelPath, codecPath, baselinePath, baseline };
}

describe("#7660 dac_conv_t1d numerical parity", () => {
	const inputs = resolveInputs();

	if ("reason" in inputs) {
		it.skip(`[skipped] ${inputs.reason}`, () => undefined);
		return;
	}

	it(
		"current binary matches pre-migration PCM within MSE tolerance",
		async () => {
			// Dynamic imports so the bun:ffi module is only touched when all
			// inputs are present. Under vitest+node the synth path would fail
			// at lib load, which would mask the real skip reason.
			const { OmnivoiceContext } = await import("../src/ffi");
			const { runSynthesis } = await import("../src/synth");

			const ctx = await OmnivoiceContext.open({
				modelPath: inputs.modelPath,
				codecPath: inputs.codecPath,
			});
			try {
				const result = await runSynthesis(ctx, {
					text: PARITY_FIXTURE.text,
					lang: PARITY_FIXTURE.lang,
					instruct: PARITY_FIXTURE.instruct,
					maskgit: { seed: PARITY_FIXTURE.seed },
				});

				expect(result.sampleRate).toBe(inputs.baseline.header.sampleRate);
				expect(result.channels).toBe(inputs.baseline.header.channels);
				expect(result.samples.length).toBe(inputs.baseline.samples.length);

				const mse = computeMse(result.samples, inputs.baseline.samples);
				expect(mse).toBeLessThan(MSE_TOLERANCE);
			} finally {
				await ctx.close();
			}
		},
		120_000,
	);
});
