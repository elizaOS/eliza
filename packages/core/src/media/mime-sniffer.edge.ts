/**
 * Bounded magic-byte detection for media accepted by the Workerd chat path.
 * It covers the image, audio, video, archive, and document formats delivered by
 * supported connectors without importing Node-only filesystem detection code.
 */

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
	signature.every((byte, index) => bytes[index] === byte);

const textAt = (bytes: Uint8Array, offset: number, length: number): string =>
	String.fromCharCode(...bytes.subarray(offset, offset + length));

export async function sniffMime(
	buffer?: Buffer | Uint8Array,
): Promise<string | undefined> {
	if (!buffer) return undefined;
	const bytes: Uint8Array = buffer;

	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		return "image/png";
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (textAt(bytes, 0, 6) === "GIF87a" || textAt(bytes, 0, 6) === "GIF89a")
		return "image/gif";
	if (textAt(bytes, 0, 4) === "RIFF" && textAt(bytes, 8, 4) === "WEBP")
		return "image/webp";
	if (textAt(bytes, 0, 5) === "%PDF-") return "application/pdf";
	if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "application/zip";
	if (startsWith(bytes, [0x1f, 0x8b])) return "application/gzip";
	if (textAt(bytes, 0, 4) === "OggS") return "audio/ogg";
	if (textAt(bytes, 0, 3) === "ID3") return "audio/mpeg";
	if (textAt(bytes, 0, 4) === "RIFF" && textAt(bytes, 8, 4) === "WAVE")
		return "audio/wav";
	if (textAt(bytes, 4, 4) === "ftyp") return "video/mp4";
	return undefined;
}
