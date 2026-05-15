#!/usr/bin/env bun
/**
 * Manually regenerate `cache/voice-preset-default.bin` (Samantha) for an
 * installed Eliza-1 bundle.
 *
 * The runtime auto-regenerates on first boot when it detects the I-wave
 * zero-fill placeholder; this script is the operator escape-hatch for:
 *   - re-baselining the preset after the OmniVoice library bumps,
 *   - rebuilding the preset on a different hardware tier,
 *   - producing a preset against a custom reference clip.
 *
 * Usage:
 *
 *   bun plugins/plugin-local-inference/scripts/regenerate-samantha-preset.mjs \
 *       --bundle ~/.eliza/local-inference/models/eliza-1-0_8b
 *
 * Optional flags:
 *
 *   --reference-wav PATH    Override the bundled Samantha reference clip.
 *                           Must be 24 kHz mono fp32 WAV. The runtime ships
 *                           a default at <bundle>/tts/omnivoice/samantha-ref.wav;
 *                           override only when synthesising from a custom
 *                           audio source (e.g. operator-recorded prompt).
 *
 *   --reference-text TEXT   Override the canonical reference transcript.
 *                           Defaults to the pinned Samantha line in
 *                           src/services/voice/samantha-preset-placeholder.ts.
 *
 *   --out PATH              Write the resulting preset to PATH instead of
 *                           the bundle's `cache/voice-preset-default.bin`.
 *                           The runtime ignores presets at non-canonical
 *                           paths — use this only for inspection/testing.
 *
 *   --force                 Regenerate even when the existing preset is NOT
 *                           the I-wave placeholder. Without this flag the
 *                           script refuses to overwrite operator-supplied
 *                           presets.
 *
 *   --dry-run               Print the plan + detection result; do not write.
 *
 * Exit codes:
 *   0   regeneration succeeded (or dry-run plan printed).
 *   1   unrecoverable runtime error (FFI missing, reference clip missing,
 *       OmniVoice synthesis failed). The error message lists the cause.
 *   2   refused to overwrite a non-placeholder preset; pass --force.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");

function parseArgs(argv) {
	const args = {
		bundle: null,
		referenceWav: null,
		referenceText: null,
		out: null,
		force: false,
		dryRun: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case "--bundle":
				args.bundle = argv[++i];
				break;
			case "--reference-wav":
				args.referenceWav = argv[++i];
				break;
			case "--reference-text":
				args.referenceText = argv[++i];
				break;
			case "--out":
				args.out = argv[++i];
				break;
			case "--force":
				args.force = true;
				break;
			case "--dry-run":
				args.dryRun = true;
				break;
			case "-h":
			case "--help":
				printUsageAndExit(0);
				break;
			default:
				process.stderr.write(`Unknown argument: ${a}\n`);
				printUsageAndExit(2);
		}
	}
	if (!args.bundle && !args.out) {
		process.stderr.write("--bundle (or --out) is required\n");
		printUsageAndExit(2);
	}
	return args;
}

function printUsageAndExit(code) {
	process.stdout.write(
		[
			"Usage: regenerate-samantha-preset.mjs --bundle ROOT [options]",
			"",
			"  --bundle PATH         Eliza-1 bundle root.",
			"  --reference-wav PATH  Override the Samantha reference clip (24 kHz mono fp32 WAV).",
			"  --reference-text STR  Override the canonical reference transcript.",
			"  --out PATH            Write to PATH instead of <bundle>/cache/voice-preset-default.bin.",
			"  --force               Overwrite even non-placeholder presets.",
			"  --dry-run             Print the plan; do not write.",
			"",
		].join("\n"),
	);
	process.exit(code);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	const { detectSamanthaPlaceholder, SAMANTHA_REFERENCE_TRANSCRIPT } =
		await import(
			path.join(
				PLUGIN_ROOT,
				"src",
				"services",
				"voice",
				"samantha-preset-placeholder.ts",
			)
		);

	const bundleRoot = args.bundle ? path.resolve(args.bundle) : null;
	const presetPath =
		args.out !== null
			? path.resolve(args.out)
			: path.join(bundleRoot, "cache", "voice-preset-default.bin");

	process.stdout.write(`[regen-samantha] preset path: ${presetPath}\n`);
	const state = detectSamanthaPlaceholder(presetPath);
	process.stdout.write(
		`[regen-samantha] detection: kind=${state.kind}${
			state.kind !== "placeholder" && state.kind !== "missing"
				? ` reason="${state.reason}"`
				: ""
		}\n`,
	);

	if (state.kind === "real-preset" && !args.force) {
		process.stderr.write(
			"[regen-samantha] refusing to overwrite a non-placeholder preset. Pass --force to override.\n",
		);
		process.exit(2);
	}

	const refText = args.referenceText ?? SAMANTHA_REFERENCE_TRANSCRIPT;
	const refWav = args.referenceWav
		? path.resolve(args.referenceWav)
		: bundleRoot
			? path.join(bundleRoot, "tts", "omnivoice", "samantha-ref.wav")
			: null;

	process.stdout.write(`[regen-samantha] reference text: ${JSON.stringify(refText)}\n`);
	process.stdout.write(`[regen-samantha] reference wav:  ${refWav ?? "<none>"}\n`);

	if (args.dryRun) {
		process.stdout.write("[regen-samantha] --dry-run set; no bytes written.\n");
		return;
	}

	if (!bundleRoot) {
		process.stderr.write(
			"[regen-samantha] cannot regenerate without --bundle (need the OmniVoice FFI library + ABI context).\n",
		);
		process.exit(1);
	}

	if (!refWav || !existsSync(refWav)) {
		process.stderr.write(
			`[regen-samantha] reference WAV not found at ${refWav}. Stage the bundled samantha-ref.wav or pass --reference-wav.\n`,
		);
		process.exit(1);
	}

	const { regenerateSamanthaPresetFromBundle } = await import(
		path.join(
			PLUGIN_ROOT,
			"src",
			"services",
			"voice",
			"samantha-preset-regenerator.ts",
		)
	);

	const result = await regenerateSamanthaPresetFromBundle({
		bundleRoot,
		presetPath,
		referenceWav: refWav,
		referenceText: refText,
	});

	mkdirSync(path.dirname(presetPath), { recursive: true });
	writeFileSync(presetPath, result.bytes);
	process.stdout.write(
		`[regen-samantha] wrote ${result.bytes.byteLength} bytes -> ${presetPath} (refT=${result.refT}, K=${result.K})\n`,
	);
}

main().catch((err) => {
	process.stderr.write(`[regen-samantha] ${err?.stack ?? err}\n`);
	process.exit(1);
});
