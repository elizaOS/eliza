/**
 * Image processing utilities for Eliza.
 *
 * Provides image resizing, format conversion, and EXIF handling.
 * Supports both Sharp and macOS sips for Bun compatibility.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

type Sharp = typeof import("sharp");

export type ImageMetadata = {
	width: number;
	height: number;
};

function isBun(): boolean {
	return typeof (process.versions as { bun?: unknown }).bun === "string";
}

function prefersSips(): boolean {
	return (
		process.env.ELIZA_IMAGE_BACKEND === "sips" ||
		(process.env.ELIZA_IMAGE_BACKEND !== "sharp" &&
			isBun() &&
			process.platform === "darwin")
	);
}

async function loadSharp(): Promise<(buffer: Buffer) => ReturnType<Sharp>> {
	const mod = (await import("sharp")) as unknown as { default?: Sharp };
	const sharp = mod.default ?? (mod as unknown as Sharp);
	return (buffer) => sharp(buffer, { failOnError: false });
}

/**
 * Reads EXIF orientation from JPEG buffer.
 * Returns orientation value 1-8, or null if not found/not JPEG.
 */
function readJpegExifOrientation(buffer: Buffer): number | null {
	// Check JPEG magic bytes
	if (buffer.length < 2 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
		return null;
	}

	let offset = 2;
	while (offset < buffer.length - 4) {
		// Look for marker
		if (buffer[offset] !== 0xff) {
			offset++;
			continue;
		}

		const marker = buffer[offset + 1];
		// Skip padding FF bytes
		if (marker === 0xff) {
			offset++;
			continue;
		}

		// APP1 marker (EXIF)
		if (marker === 0xe1) {
			const exifStart = offset + 4;

			// Check for "Exif\0\0" header
			if (
				buffer.length > exifStart + 6 &&
				buffer.toString("ascii", exifStart, exifStart + 4) === "Exif" &&
				buffer[exifStart + 4] === 0 &&
				buffer[exifStart + 5] === 0
			) {
				const tiffStart = exifStart + 6;
				if (buffer.length < tiffStart + 8) {
					return null;
				}

				// Check byte order (II = little-endian, MM = big-endian)
				const byteOrder = buffer.toString("ascii", tiffStart, tiffStart + 2);
				const isLittleEndian = byteOrder === "II";

				const readU16 = (pos: number) =>
					isLittleEndian ? buffer.readUInt16LE(pos) : buffer.readUInt16BE(pos);
				const readU32 = (pos: number) =>
					isLittleEndian ? buffer.readUInt32LE(pos) : buffer.readUInt32BE(pos);

				// Read IFD0 offset
				const ifd0Offset = readU32(tiffStart + 4);
				const ifd0Start = tiffStart + ifd0Offset;
				if (buffer.length < ifd0Start + 2) {
					return null;
				}

				const numEntries = readU16(ifd0Start);
				for (let i = 0; i < numEntries; i++) {
					const entryOffset = ifd0Start + 2 + i * 12;
					if (buffer.length < entryOffset + 12) {
						break;
					}

					const tag = readU16(entryOffset);
					// Orientation tag = 0x0112
					if (tag === 0x0112) {
						const value = readU16(entryOffset + 8);
						return value >= 1 && value <= 8 ? value : null;
					}
				}
			}
			return null;
		}

		// Skip other segments
		if (marker >= 0xe0 && marker <= 0xef) {
			const segmentLength = buffer.readUInt16BE(offset + 2);
			offset += 2 + segmentLength;
			continue;
		}

		// SOF, SOS, or other marker - stop searching
		if (marker === 0xc0 || marker === 0xda) {
			break;
		}

		offset++;
	}

	return null;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-img-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

async function runExec(
	cmd: string,
	args: string[],
	options: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

		let stdout = "";
		let stderr = "";
		let killed = false;

		const timeout = options.timeoutMs
			? setTimeout(() => {
					killed = true;
					child.kill("SIGKILL");
				}, options.timeoutMs)
			: null;

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");

		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
			if (options.maxBuffer && stdout.length > options.maxBuffer) {
				killed = true;
				child.kill("SIGKILL");
			}
		});

		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});

		child.once("error", (err) => {
			if (timeout) clearTimeout(timeout);
			reject(err);
		});

		child.once("exit", (code) => {
			if (timeout) clearTimeout(timeout);
			if (killed) {
				reject(new Error("Process killed (timeout or buffer exceeded)"));
				return;
			}
			if (code !== 0) {
				reject(new Error(`Command failed with exit code ${code}: ${stderr}`));
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}

async function sipsMetadataFromBuffer(
	buffer: Buffer,
): Promise<ImageMetadata | null> {
	return await withTempDir(async (dir) => {
		const input = path.join(dir, "in.img");
		await fs.writeFile(input, buffer);
		const { stdout } = await runExec(
			"/usr/bin/sips",
			["-g", "pixelWidth", "-g", "pixelHeight", input],
			{
				timeoutMs: 10_000,
				maxBuffer: 512 * 1024,
			},
		);
		const w = stdout.match(/pixelWidth:\s*([0-9]+)/);
		const h = stdout.match(/pixelHeight:\s*([0-9]+)/);
		if (!w?.[1] || !h?.[1]) {
			return null;
		}
		const width = Number.parseInt(w[1], 10);
		const height = Number.parseInt(h[1], 10);
		if (!Number.isFinite(width) || !Number.isFinite(height)) {
			return null;
		}
		if (width <= 0 || height <= 0) {
			return null;
		}
		return { width, height };
	});
}

async function sipsResizeToJpeg(params: {
	buffer: Buffer;
	maxSide: number;
	quality: number;
}): Promise<Buffer> {
	return await withTempDir(async (dir) => {
		const input = path.join(dir, "in.img");
		const output = path.join(dir, "out.jpg");
		await fs.writeFile(input, params.buffer);
		await runExec(
			"/usr/bin/sips",
			[
				"-Z",
				String(Math.max(1, Math.round(params.maxSide))),
				"-s",
				"format",
				"jpeg",
				"-s",
				"formatOptions",
				String(Math.max(1, Math.min(100, Math.round(params.quality)))),
				input,
				"--out",
				output,
			],
			{ timeoutMs: 20_000, maxBuffer: 1024 * 1024 },
		);
		return await fs.readFile(output);
	});
}

async function sipsConvertToJpeg(buffer: Buffer): Promise<Buffer> {
	return await withTempDir(async (dir) => {
		const input = path.join(dir, "in.heic");
		const output = path.join(dir, "out.jpg");
		await fs.writeFile(input, buffer);
		await runExec(
			"/usr/bin/sips",
			["-s", "format", "jpeg", input, "--out", output],
			{
				timeoutMs: 20_000,
				maxBuffer: 1024 * 1024,
			},
		);
		return await fs.readFile(output);
	});
}

/**
 * Get image dimensions from a buffer.
 */
export async function getImageMetadata(
	buffer: Buffer,
): Promise<ImageMetadata | null> {
	if (prefersSips()) {
		return await sipsMetadataFromBuffer(buffer).catch(() => null);
	}

	try {
		const sharp = await loadSharp();
		const meta = await sharp(buffer).metadata();
		const width = Number(meta.width ?? 0);
		const height = Number(meta.height ?? 0);
		if (!Number.isFinite(width) || !Number.isFinite(height)) {
			return null;
		}
		if (width <= 0 || height <= 0) {
			return null;
		}
		return { width, height };
	} catch {
		return null;
	}
}

/**
 * Applies rotation/flip to image buffer using sips based on EXIF orientation.
 */
async function sipsApplyOrientation(
	buffer: Buffer,
	orientation: number,
): Promise<Buffer> {
	const ops: string[] = [];
	switch (orientation) {
		case 2: // Flip horizontal
			ops.push("-f", "horizontal");
			break;
		case 3: // Rotate 180
			ops.push("-r", "180");
			break;
		case 4: // Flip vertical
			ops.push("-f", "vertical");
			break;
		case 5: // Rotate 270 CW + flip horizontal
			ops.push("-r", "270", "-f", "horizontal");
			break;
		case 6: // Rotate 90 CW
			ops.push("-r", "90");
			break;
		case 7: // Rotate 90 CW + flip horizontal
			ops.push("-r", "90", "-f", "horizontal");
			break;
		case 8: // Rotate 270 CW
			ops.push("-r", "270");
			break;
		default:
			return buffer;
	}

	return await withTempDir(async (dir) => {
		const input = path.join(dir, "in.jpg");
		const output = path.join(dir, "out.jpg");
		await fs.writeFile(input, buffer);
		await runExec("/usr/bin/sips", [...ops, input, "--out", output], {
			timeoutMs: 20_000,
			maxBuffer: 1024 * 1024,
		});
		return await fs.readFile(output);
	});
}

/**
 * Normalizes EXIF orientation in an image buffer.
 * Returns the buffer with correct pixel orientation (rotated if needed).
 */
export async function normalizeExifOrientation(
	buffer: Buffer,
): Promise<Buffer> {
	if (prefersSips()) {
		try {
			const orientation = readJpegExifOrientation(buffer);
			if (!orientation || orientation === 1) {
				return buffer;
			}
			return await sipsApplyOrientation(buffer, orientation);
		} catch {
			return buffer;
		}
	}

	try {
		const sharp = await loadSharp();
		return await sharp(buffer).rotate().toBuffer();
	} catch {
		return buffer;
	}
}

/**
 * Internal sips-only EXIF normalization.
 */
async function normalizeExifOrientationSips(buffer: Buffer): Promise<Buffer> {
	try {
		const orientation = readJpegExifOrientation(buffer);
		if (!orientation || orientation === 1) {
			return buffer;
		}
		return await sipsApplyOrientation(buffer, orientation);
	} catch {
		return buffer;
	}
}

/**
 * Resize an image to JPEG format.
 */
export async function resizeToJpeg(params: {
	buffer: Buffer;
	maxSide: number;
	quality: number;
	withoutEnlargement?: boolean;
}): Promise<Buffer> {
	if (prefersSips()) {
		const normalized = await normalizeExifOrientationSips(params.buffer);

		if (params.withoutEnlargement !== false) {
			const meta = await getImageMetadata(normalized);
			if (meta) {
				const maxDim = Math.max(meta.width, meta.height);
				if (maxDim > 0 && maxDim <= params.maxSide) {
					return await sipsResizeToJpeg({
						buffer: normalized,
						maxSide: maxDim,
						quality: params.quality,
					});
				}
			}
		}
		return await sipsResizeToJpeg({
			buffer: normalized,
			maxSide: params.maxSide,
			quality: params.quality,
		});
	}

	const sharp = await loadSharp();
	return await sharp(params.buffer)
		.rotate()
		.resize({
			width: params.maxSide,
			height: params.maxSide,
			fit: "inside",
			withoutEnlargement: params.withoutEnlargement !== false,
		})
		.jpeg({ quality: params.quality, mozjpeg: true })
		.toBuffer();
}

/**
 * Convert HEIC/HEIF image to JPEG.
 */
export async function convertHeicToJpeg(buffer: Buffer): Promise<Buffer> {
	if (prefersSips()) {
		return await sipsConvertToJpeg(buffer);
	}
	const sharp = await loadSharp();
	return await sharp(buffer).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

/**
 * Check if an image has an alpha channel (transparency).
 */
export async function hasAlphaChannel(buffer: Buffer): Promise<boolean> {
	try {
		const sharp = await loadSharp();
		const meta = await sharp(buffer).metadata();
		return meta.hasAlpha || meta.channels === 4;
	} catch {
		return false;
	}
}

/**
 * Resize an image to PNG format, preserving alpha channel.
 */
export async function resizeToPng(params: {
	buffer: Buffer;
	maxSide: number;
	compressionLevel?: number;
	withoutEnlargement?: boolean;
}): Promise<Buffer> {
	const sharp = await loadSharp();
	const compressionLevel = params.compressionLevel ?? 6;

	return await sharp(params.buffer)
		.rotate()
		.resize({
			width: params.maxSide,
			height: params.maxSide,
			fit: "inside",
			withoutEnlargement: params.withoutEnlargement !== false,
		})
		.png({ compressionLevel })
		.toBuffer();
}

/**
 * Optimize an image to PNG format within a size limit.
 */
export async function optimizeImageToPng(
	buffer: Buffer,
	maxBytes: number,
): Promise<{
	buffer: Buffer;
	optimizedSize: number;
	resizeSide: number;
	compressionLevel: number;
}> {
	const sides = [2048, 1536, 1280, 1024, 800];
	const compressionLevels = [6, 7, 8, 9];
	let smallest: {
		buffer: Buffer;
		size: number;
		resizeSide: number;
		compressionLevel: number;
	} | null = null;

	for (const side of sides) {
		for (const compressionLevel of compressionLevels) {
			try {
				const out = await resizeToPng({
					buffer,
					maxSide: side,
					compressionLevel,
					withoutEnlargement: true,
				});
				const size = out.length;
				if (!smallest || size < smallest.size) {
					smallest = { buffer: out, size, resizeSide: side, compressionLevel };
				}
				if (size <= maxBytes) {
					return {
						buffer: out,
						optimizedSize: size,
						resizeSide: side,
						compressionLevel,
					};
				}
			} catch {
				// Continue trying other combinations
			}
		}
	}

	if (smallest) {
		return {
			buffer: smallest.buffer,
			optimizedSize: smallest.size,
			resizeSide: smallest.resizeSide,
			compressionLevel: smallest.compressionLevel,
		};
	}

	throw new Error("Failed to optimize PNG image");
}
