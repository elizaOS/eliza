#!/usr/bin/env node
/**
 * Speaker-encoder INT8-vs-FP32 parity smoke harness.
 *
 * The WeSpeaker ResNet34-LM speaker encoder ships in two flavors:
 *   - int8 ONNX (~7 MB, default runtime model — `WESPEAKER_RESNET34_LM_INT8_MODEL_ID`),
 *   - fp32 ONNX (~25 MB, eval-only / parity reference).
 *
 * The runtime always loads the int8 model. Before publishing a new
 * checkpoint we want to know that the int8 quantization did not
 * silently degrade the embedding space — i.e. that the cosine
 * similarity between the int8 and fp32 embeddings of the same audio
 * window stays ≥ 0.995 on a held-out set of probe clips.
 *
 * This harness:
 *   - locates both ONNX files (env override → bundle default → repo fixture),
 *   - runs each WAV in the probe directory through both encoders,
 *   - reports per-clip cosine, mean / min / max, and pass/fail at the
 *     `--cos-min` threshold (default 0.995).
 *
 * Like the other verify harnesses (Eliza-1 AGENTS.md §3), when a
 * model file or `onnxruntime-node` is missing the harness writes
 * `status: "skipped"` and exits 0. It does NOT fabricate numbers.
 *
 * Usage:
 *   node plugins/plugin-local-inference/native/verify/speaker_encoder_parity.mjs \
 *     [--int8 PATH] [--fp32 PATH] [--probes DIR] [--cos-min 0.995] \
 *     [--report PATH] [--json]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_BUNDLE = path.join(
	os.homedir(),
	".eliza",
	"local-inference",
	"models",
	"voice",
);
const DEFAULT_PROBES = path.join(PLUGIN_ROOT, "native", "verify", "fixtures", "speaker-probes");

function parseArgs(argv) {
	const out = {
		int8: process.env.WESPEAKER_INT8_PATH || null,
		fp32: process.env.WESPEAKER_FP32_PATH || null,
		probes: DEFAULT_PROBES,
		cosMin: 0.995,
		report: null,
		json: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a === "--int8") out.int8 = argv[++i];
		else if (a === "--fp32") out.fp32 = argv[++i];
		else if (a === "--probes") out.probes = argv[++i];
		else if (a === "--cos-min") out.cosMin = Number.parseFloat(argv[++i]) || out.cosMin;
		else if (a === "--report") out.report = argv[++i];
		else if (a === "--json") out.json = true;
	}
	return out;
}

function findFirst(...candidates) {
	for (const c of candidates) {
		if (c && fs.existsSync(c)) return c;
	}
	return null;
}

function resolveModelPath(explicit, defaults) {
	if (explicit) {
		return fs.existsSync(explicit) ? explicit : null;
	}
	return findFirst(...defaults);
}

/**
 * Decode a 16-bit-PCM .wav file into a `Float32Array` at the file's
 * native sample rate. Mono only. Returns `null` if the file is not a
 * supported PCM WAV. We intentionally don't resample here — the
 * harness only loads pre-conditioned 16 kHz mono probes.
 */
function loadMonoPcm(wavPath) {
	const buf = fs.readFileSync(wavPath);
	if (buf.length < 44) return null;
	if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
	if (buf.toString("ascii", 8, 12) !== "WAVE") return null;
	// Walk the chunks to find `fmt ` and `data` — robust to LIST/INFO chunks.
	let offset = 12;
	let fmt = null;
	let dataOffset = -1;
	let dataLen = 0;
	while (offset + 8 <= buf.length) {
		const id = buf.toString("ascii", offset, offset + 4);
		const size = buf.readUInt32LE(offset + 4);
		if (id === "fmt ") {
			fmt = {
				audioFormat: buf.readUInt16LE(offset + 8),
				numChannels: buf.readUInt16LE(offset + 10),
				sampleRate: buf.readUInt32LE(offset + 12),
				bitsPerSample: buf.readUInt16LE(offset + 22),
			};
		} else if (id === "data") {
			dataOffset = offset + 8;
			dataLen = size;
			break;
		}
		offset += 8 + size + (size % 2);
	}
	if (!fmt || dataOffset < 0) return null;
	if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16 || fmt.numChannels !== 1) {
		return null;
	}
	const sampleCount = dataLen / 2;
	const pcm = new Float32Array(sampleCount);
	for (let i = 0; i < sampleCount; i += 1) {
		pcm[i] = buf.readInt16LE(dataOffset + i * 2) / 32768;
	}
	return { pcm, sampleRate: fmt.sampleRate };
}

function cosineSim(a, b) {
	if (a.length !== b.length) {
		throw new Error(`embedding length mismatch: ${a.length} vs ${b.length}`);
	}
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i += 1) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom > 0 ? dot / denom : 0;
}

async function loadOnnxRuntime() {
	try {
		return await import("onnxruntime-node");
	} catch {
		return null;
	}
}

async function encodeOne(session, Tensor, pcm) {
	const inputName = session.inputNames[0];
	const outputName = session.outputNames[0];
	const tensor = new Tensor("float32", pcm, [1, pcm.length]);
	const feeds = { [inputName]: tensor };
	const result = await session.run(feeds);
	const out = result[outputName];
	return Float32Array.from(out.data);
}

function timestamp() {
	return new Date()
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const reportPath =
		args.report ||
		path.join(
			PLUGIN_ROOT,
			"native",
			"verify",
			"reports",
			`speaker-encoder-parity-${timestamp()}.json`,
		);
	const status = {
		schemaVersion: 1,
		kind: "speaker-encoder-parity",
		generatedAt: new Date().toISOString(),
		status: "ok",
		cosMin: args.cosMin,
		int8Path: null,
		fp32Path: null,
		probes: [],
		summary: null,
		skipReason: null,
	};

	const int8Path = resolveModelPath(args.int8, [
		path.join(DEFAULT_BUNDLE, "wespeaker-resnet34-lm-int8.onnx"),
		path.join(DEFAULT_BUNDLE, "speaker", "wespeaker-resnet34-lm-int8.onnx"),
	]);
	const fp32Path = resolveModelPath(args.fp32, [
		path.join(DEFAULT_BUNDLE, "wespeaker-resnet34-lm-fp32.onnx"),
		path.join(DEFAULT_BUNDLE, "speaker", "wespeaker-resnet34-lm-fp32.onnx"),
	]);
	status.int8Path = int8Path;
	status.fp32Path = fp32Path;

	if (!int8Path || !fp32Path) {
		status.status = "skipped";
		status.skipReason = `missing model file: int8=${int8Path ?? "?"} fp32=${fp32Path ?? "?"}`;
		writeReport(reportPath, status, args);
		return 0;
	}

	if (!fs.existsSync(args.probes)) {
		status.status = "skipped";
		status.skipReason = `probes dir not found: ${args.probes}`;
		writeReport(reportPath, status, args);
		return 0;
	}

	const ort = await loadOnnxRuntime();
	if (!ort) {
		status.status = "skipped";
		status.skipReason = "onnxruntime-node not installed";
		writeReport(reportPath, status, args);
		return 0;
	}

	const probes = fs
		.readdirSync(args.probes)
		.filter((f) => f.toLowerCase().endsWith(".wav"))
		.sort()
		.map((f) => path.join(args.probes, f));

	if (probes.length === 0) {
		status.status = "skipped";
		status.skipReason = `no .wav probes under ${args.probes}`;
		writeReport(reportPath, status, args);
		return 0;
	}

	const int8Session = await ort.InferenceSession.create(int8Path);
	const fp32Session = await ort.InferenceSession.create(fp32Path);

	let sumCos = 0;
	let minCos = Number.POSITIVE_INFINITY;
	let maxCos = Number.NEGATIVE_INFINITY;
	let n = 0;
	let failures = 0;

	for (const probe of probes) {
		const decoded = loadMonoPcm(probe);
		if (!decoded) {
			status.probes.push({ probe, skipped: true, reason: "unsupported wav" });
			continue;
		}
		if (decoded.sampleRate !== 16_000) {
			status.probes.push({
				probe,
				skipped: true,
				reason: `expected 16 kHz, got ${decoded.sampleRate}`,
			});
			continue;
		}
		const e8 = await encodeOne(int8Session, ort.Tensor, decoded.pcm);
		const e32 = await encodeOne(fp32Session, ort.Tensor, decoded.pcm);
		const cos = cosineSim(e8, e32);
		const pass = cos >= args.cosMin;
		if (!pass) failures += 1;
		sumCos += cos;
		if (cos < minCos) minCos = cos;
		if (cos > maxCos) maxCos = cos;
		n += 1;
		status.probes.push({ probe, cos, pass });
	}

	if (n === 0) {
		status.status = "skipped";
		status.skipReason = "no usable probes";
	} else {
		status.summary = {
			n,
			meanCos: sumCos / n,
			minCos,
			maxCos,
			failures,
		};
		status.status = failures === 0 ? "ok" : "fail";
	}

	writeReport(reportPath, status, args);
	return status.status === "fail" ? 1 : 0;
}

function writeReport(reportPath, status, args) {
	fs.mkdirSync(path.dirname(reportPath), { recursive: true });
	fs.writeFileSync(reportPath, `${JSON.stringify(status, null, 2)}\n`);
	if (args.json) {
		process.stdout.write(`${JSON.stringify(status)}\n`);
	} else {
		const line =
			status.status === "ok" && status.summary
				? `speaker-encoder-parity: PASS (n=${status.summary.n}, meanCos=${status.summary.meanCos.toFixed(5)}, minCos=${status.summary.minCos.toFixed(5)})`
				: status.status === "fail" && status.summary
					? `speaker-encoder-parity: FAIL (n=${status.summary.n}, failures=${status.summary.failures}, minCos=${status.summary.minCos.toFixed(5)})`
					: `speaker-encoder-parity: SKIPPED (${status.skipReason ?? "no reason"})`;
		process.stdout.write(`${line}\nreport=${reportPath}\n`);
	}
}

main()
	.then((rc) => process.exit(rc))
	.catch((err) => {
		process.stderr.write(`speaker-encoder-parity: ${err?.stack ?? err}\n`);
		process.exit(2);
	});
