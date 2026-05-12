import fs from "node:fs";
import path from "node:path";

export interface WhisperResult {
	text: string;
	segments: WhisperSegment[];
	language?: string;
	duration?: number;
}

export interface WhisperSegment {
	text: string;
	start: number; // seconds
	end: number; // seconds
	tokens?: WhisperToken[];
}

export interface WhisperToken {
	text: string;
	start: number;
	end: number;
	probability: number;
}

// Resolution order (first existing path wins):
//   1. ELIZA_WHISPER_BIN / ELIZA_WHISPER_MODEL env vars
//   2. Relative to import.meta.dir
//   3. Relative to process.cwd()
function resolveWhisperPath(
	envVar: string,
	relativeFromMeta: string,
	relativeFromCwd: string,
): string {
	const envValue = process.env[envVar];
	if (envValue && fs.existsSync(envValue)) {
		return envValue;
	}
	const fromMeta = path.resolve(import.meta.dir, relativeFromMeta);
	if (fs.existsSync(fromMeta)) return fromMeta;
	return path.resolve(process.cwd(), relativeFromCwd);
}

// Windows whisper.cpp binary has a .exe extension; other platforms do not.
const WHISPER_BIN_NAME = process.platform === "win32" ? "main.exe" : "main";
const WHISPER_BIN = resolveWhisperPath(
	"ELIZA_WHISPER_BIN",
	`../../../../node_modules/whisper-node/lib/whisper.cpp/${WHISPER_BIN_NAME}`,
	`node_modules/whisper-node/lib/whisper.cpp/${WHISPER_BIN_NAME}`,
);
const WHISPER_MODEL = resolveWhisperPath(
	"ELIZA_WHISPER_MODEL",
	"../../../../node_modules/whisper-node/lib/whisper.cpp/models/ggml-base.en.bin",
	"node_modules/whisper-node/lib/whisper.cpp/models/ggml-base.en.bin",
);

let whisperBinaryChecked = false;
let whisperBinaryResult = false;

export function isWhisperBinaryAvailable(): boolean {
	if (!whisperBinaryChecked) {
		whisperBinaryResult =
			fs.existsSync(WHISPER_BIN) && fs.existsSync(WHISPER_MODEL);
		whisperBinaryChecked = true;
	}
	return whisperBinaryResult;
}

/** Reset the cached result — only for testing. */
export function _resetWhisperCache(): void {
	whisperBinaryChecked = false;
	whisperBinaryResult = false;
}

/**
 * Write Float32 PCM samples to a 16-bit PCM RIFF WAV file.
 * whisper.cpp requires 16kHz mono 16-bit PCM WAV input.
 */
export function writeWavFile(
	filePath: string,
	pcmFloat32: Float32Array,
	sampleRate = 16000,
	channels = 1,
): void {
	const numSamples = pcmFloat32.length;
	const bytesPerSample = 2; // 16-bit
	const dataSize = numSamples * bytesPerSample;
	const bufferSize = 44 + dataSize;
	const buffer = Buffer.allocUnsafe(bufferSize);

	// RIFF header
	buffer.write("RIFF", 0, "ascii");
	buffer.writeUInt32LE(36 + dataSize, 4);
	buffer.write("WAVE", 8, "ascii");

	// fmt  chunk
	buffer.write("fmt ", 12, "ascii");
	buffer.writeUInt32LE(16, 16); // chunk size
	buffer.writeUInt16LE(1, 20); // PCM format
	buffer.writeUInt16LE(channels, 22);
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); // byte rate
	buffer.writeUInt16LE(channels * bytesPerSample, 32); // block align
	buffer.writeUInt16LE(16, 34); // bits per sample

	// data chunk
	buffer.write("data", 36, "ascii");
	buffer.writeUInt32LE(dataSize, 40);

	// Convert Float32 [-1, 1] to Int16
	for (let i = 0; i < numSamples; i++) {
		const s = Math.max(-1, Math.min(1, pcmFloat32[i]));
		const int16 = s < 0 ? s * 32768 : s * 32767;
		buffer.writeInt16LE(Math.round(int16), 44 + i * 2);
	}

	fs.writeFileSync(filePath, buffer);
}

/**
 * Parse whisper.cpp stdout into a WhisperResult.
 *
 * whisper.cpp output format (with --output-txt):
 *   [00:00:00.000 --> 00:00:01.230]   Hello world
 *   [00:00:01.230 --> 00:00:02.500]   How are you
 */
export function parseWhisperOutput(stdout: string): WhisperResult {
	const lines = stdout.split("\n");
	const segments: WhisperSegment[] = [];
	const textParts: string[] = [];

	// Pattern: [HH:MM:SS.mmm --> HH:MM:SS.mmm]   text
	const linePattern =
		/\[\s*(\d+:\d+:\d+\.\d+)\s*-->\s*(\d+:\d+:\d+\.\d+)\s*\]\s*(.*)/;

	for (const line of lines) {
		const match = line.match(linePattern);
		if (!match) continue;

		const start = parseTimestamp(match[1]);
		const end = parseTimestamp(match[2]);
		const text = match[3].trim();

		if (text) {
			segments.push({ text, start, end });
			textParts.push(text);
		}
	}

	return {
		text: textParts.join(" "),
		segments,
	};
}

function parseTimestamp(ts: string): number {
	// HH:MM:SS.mmm → seconds
	const parts = ts.split(":");
	const hours = Number.parseInt(parts[0], 10);
	const minutes = Number.parseInt(parts[1], 10);
	const secs = Number.parseFloat(parts[2]);
	return hours * 3600 + minutes * 60 + secs;
}

/**
 * Transcribe an audio file using the whisper.cpp binary directly.
 * Returns null if the binary is not available.
 */
export async function transcribeBunSpawn(
	audioPath: string,
): Promise<WhisperResult | null> {
	if (!isWhisperBinaryAvailable()) {
		return null;
	}

	try {
		const proc = Bun.spawn(
			[WHISPER_BIN, "-m", WHISPER_MODEL, "-f", audioPath, "-l", "en"],
			{
				stdout: "pipe",
				stderr: "pipe",
				cwd: path.dirname(WHISPER_BIN),
			},
		);

		const [stdout] = await Promise.all([
			new Response(proc.stdout).text(),
			proc.exited,
		]);

		return parseWhisperOutput(stdout);
	} catch (err) {
		console.error("[Whisper] transcribeBunSpawn failed:", err);
		return null;
	}
}

let whisperAvailable = false;
let whisperModule: Record<string, unknown> | null = null;
let whisperLoadPromise: Promise<boolean> | null = null;

async function tryLoadWhisper(): Promise<boolean> {
	if (whisperAvailable && whisperModule) {
		return true;
	}
	if (whisperLoadPromise) {
		return whisperLoadPromise;
	}

	const packages = [
		"whisper-node",
		"@nicksellen/whisper-node",
		"whisper.cpp",
		"@nicksellen/whispercpp",
	];

	whisperLoadPromise = (async () => {
		for (const pkg of packages) {
			try {
				whisperModule = await import(pkg);
				console.log(`[Whisper] Loaded ${pkg}`);
				whisperAvailable = true;
				return true;
			} catch {}
		}

		console.warn(
			"[Whisper] No whisper module available in Bun runtime. " +
				"STT will fall back to Web Speech API in renderer.",
		);
		return false;
	})();

	try {
		return await whisperLoadPromise;
	} finally {
		if (!whisperAvailable) {
			whisperLoadPromise = null;
		}
	}
}

export function isWhisperAvailable(): boolean {
	return whisperAvailable || isWhisperBinaryAvailable();
}

export function getWhisperModule(): Record<string, unknown> | null {
	return whisperModule;
}

export async function transcribe(
	_audioPath: string,
	_options?: Record<string, unknown>,
): Promise<WhisperResult | null> {
	// Try Bun.spawn path first (more reliable in Bun runtime)
	const bunResult = await transcribeBunSpawn(_audioPath);
	if (bunResult) return bunResult;

	// Fallback to dynamic import path
	if (!whisperAvailable || !whisperModule) {
		const loaded = await tryLoadWhisper();
		if (!loaded || !whisperModule) {
			return null;
		}
	}

	try {
		const whisper =
			(whisperModule as { default?: unknown }).default ?? whisperModule;
		if (typeof (whisper as { whisper?: unknown }).whisper === "function") {
			const result = await (
				whisper as { whisper: (...args: unknown[]) => Promise<unknown> }
			).whisper(_audioPath, _options);
			return result as WhisperResult;
		}
		return null;
	} catch (err) {
		console.error("[Whisper] Transcription failed:", err);
		return null;
	}
}
