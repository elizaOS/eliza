/** Explicit host-only Kokoro worker. Protocol uses fd 3; diagnostics never reach callers. */
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import {
	createKokoroSpeakerPreset,
	createKokoroTtsBackend,
} from "./services/voice/engine-bridge";
import { loadElizaInferenceFfi } from "./services/voice/ffi-bindings";
import { resolveKokoroEngineConfig } from "./services/voice/kokoro/kokoro-engine-discovery";

const emit = (value: unknown) => writeSync(3, `${JSON.stringify(value)}\n`);
const hash = (path: string, maximum: number) => {
	if (
		!isAbsolute(path) ||
		!statSync(path).isFile() ||
		statSync(path).size > maximum
	)
		throw Error("Invalid speech asset");
	return createHash("sha256").update(readFileSync(path)).digest("hex");
};
const library = process.env.ELIZA_INFERENCE_LIBRARY || "",
	root = process.env.ELIZA_KOKORO_MODEL_DIR || "";
if (
	!isAbsolute(root) ||
	hash(library, 64 * 1024 * 1024) !== process.env.ELIZA_KOKORO_LIBRARY_SHA256
)
	throw Error("Unverified speech library");
if (
	hash(join(root, "kokoro-82m-v1_0.gguf"), 256 * 1024 * 1024) !==
		"165acd9d2d9b6c2d71fa5bd52b92a2559be08567f58ed496bade076e3d9cb46c" ||
	hash(join(root, "voices/af_bella.bin"), 4 * 1024 * 1024) !==
		"f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b"
)
	throw Error("Unverified speech model or voice");
process.env.KOKORO_BACKEND = "ffi";
process.env.ELIZA_KOKORO_MODEL_FILE = "kokoro-82m-v1_0.gguf";
process.env.ELIZA_KOKORO_DEFAULT_VOICE_ID = "af_bella";
const config = resolveKokoroEngineConfig();
if (!config) throw Error("Missing speech assets");
const ffi = loadElizaInferenceFfi(library);
if (Number(ffi.libraryAbiVersion) < 14 || !ffi.kokoroSupported?.())
	throw Error("Unsupported speech ABI");
const backend = createKokoroTtsBackend(config, { ffi }),
	preset = createKokoroSpeakerPreset(config);
async function synthesize(text: string) {
	const chunks: Float32Array[] = [];
	let samples = 0;
	await backend.synthesizeStream({
		phrase: {
			id: 1,
			text,
			fromIndex: 0,
			toIndex: text.length,
			terminator: "punctuation",
		},
		preset,
		cancelSignal: { cancelled: false },
		onChunk: (chunk) => {
			if (!chunk.isFinal && chunk.pcm.length) {
				if (chunk.sampleRate !== 24000)
					throw Error("Invalid speech sample rate");
				samples += chunk.pcm.length;
				if (samples > 30 * 24000) throw Error("Speech exceeds duration limit");
				chunks.push(new Float32Array(chunk.pcm));
			}
		},
	});
	if (!samples) throw Error("No speech audio");
	const audio = Buffer.alloc(44 + samples * 2);
	audio.write("RIFF");
	audio.writeUInt32LE(audio.length - 8, 4);
	audio.write("WAVE", 8);
	audio.write("fmt ", 12);
	audio.writeUInt32LE(16, 16);
	audio.writeUInt16LE(1, 20);
	audio.writeUInt16LE(1, 22);
	audio.writeUInt32LE(24000, 24);
	audio.writeUInt32LE(48000, 28);
	audio.writeUInt16LE(2, 32);
	audio.writeUInt16LE(16, 34);
	audio.write("data", 36);
	audio.writeUInt32LE(samples * 2, 40);
	let offset = 44;
	for (const chunk of chunks)
		for (const sample of chunk) {
			if (!Number.isFinite(sample)) throw Error("Invalid speech sample");
			const value = Math.max(-1, Math.min(1, sample));
			audio.writeInt16LE(
				Math.round(value * (value < 0 ? 32768 : 32767)),
				offset,
			);
			offset += 2;
		}
	return audio;
}
try {
	await synthesize("Ready.");
	emit({ ready: true });
	for await (const line of createInterface({
		input: process.stdin,
		crlfDelay: Infinity,
	})) {
		if (line.length > 8192) throw Error("Oversized speech request");
		const input = JSON.parse(line);
		if (
			typeof input.id !== "string" ||
			!/^[0-9a-f-]{36}$/i.test(input.id) ||
			typeof input.text !== "string" ||
			!input.text.trim() ||
			input.text.length > 500
		)
			throw Error("Invalid speech request");
		try {
			const audio = await synthesize(input.text);
			emit({ id: input.id, audio: audio.toString("base64") });
		} catch {
			emit({ id: input.id, error: "synthesis_failed" });
		}
	}
} finally {
	backend.dispose();
	ffi.close?.();
}
