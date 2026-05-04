import { describe, expect, it } from "vitest";
import {
	extensionForMime,
	getFileExtension,
	imageMimeFromFormat,
	isAudioFileName,
	isGifMedia,
	isVoiceCompatibleAudio,
	mediaKindFromMime,
} from "./mime.js";

describe("getFileExtension", () => {
	it("extracts extension from simple path", () => {
		expect(getFileExtension("test.jpg")).toBe(".jpg");
	});

	it("extracts extension from path with directory", () => {
		expect(getFileExtension("path/to/file.PNG")).toBe(".png");
	});

	it("returns undefined for no extension", () => {
		expect(getFileExtension("noext")).toBeUndefined();
	});

	it("returns undefined for null input", () => {
		expect(getFileExtension(null)).toBeUndefined();
	});

	it("extracts extension from URL", () => {
		expect(getFileExtension("https://example.com/image.webp")).toBe(".webp");
	});
});

describe("mediaKindFromMime", () => {
	it("returns image for image MIME types", () => {
		expect(mediaKindFromMime("image/jpeg")).toBe("image");
		expect(mediaKindFromMime("image/png")).toBe("image");
	});

	it("returns audio for audio MIME types", () => {
		expect(mediaKindFromMime("audio/mp3")).toBe("audio");
		expect(mediaKindFromMime("audio/ogg")).toBe("audio");
	});

	it("returns video for video MIME types", () => {
		expect(mediaKindFromMime("video/mp4")).toBe("video");
	});

	it("returns document for document MIME types", () => {
		expect(mediaKindFromMime("application/pdf")).toBe("document");
		expect(mediaKindFromMime("text/plain")).toBe("document");
	});

	it("returns unknown for other MIME types", () => {
		expect(mediaKindFromMime("application/octet-stream")).toBe("unknown");
		expect(mediaKindFromMime(null)).toBe("unknown");
	});
});

describe("isAudioFileName", () => {
	it("returns true for audio files", () => {
		expect(isAudioFileName("song.mp3")).toBe(true);
		expect(isAudioFileName("voice.ogg")).toBe(true);
		expect(isAudioFileName("music.wav")).toBe(true);
	});

	it("returns false for non-audio files", () => {
		expect(isAudioFileName("image.jpg")).toBe(false);
		expect(isAudioFileName("document.pdf")).toBe(false);
	});

	it("returns false for null", () => {
		expect(isAudioFileName(null)).toBe(false);
	});
});

describe("isGifMedia", () => {
	it("returns true for GIF content type", () => {
		expect(isGifMedia({ contentType: "image/gif" })).toBe(true);
	});

	it("returns true for GIF filename", () => {
		expect(isGifMedia({ fileName: "animation.gif" })).toBe(true);
	});

	it("returns false for non-GIF", () => {
		expect(isGifMedia({ contentType: "image/jpeg" })).toBe(false);
		expect(isGifMedia({ fileName: "photo.jpg" })).toBe(false);
	});
});

describe("isVoiceCompatibleAudio", () => {
	it("returns true for ogg/opus content types", () => {
		expect(isVoiceCompatibleAudio({ contentType: "audio/ogg" })).toBe(true);
		expect(isVoiceCompatibleAudio({ contentType: "audio/opus" })).toBe(true);
	});

	it("returns true for ogg/opus filenames", () => {
		expect(isVoiceCompatibleAudio({ fileName: "voice.ogg" })).toBe(true);
		expect(isVoiceCompatibleAudio({ fileName: "voice.opus" })).toBe(true);
	});

	it("returns false for non-voice-compatible audio", () => {
		expect(isVoiceCompatibleAudio({ contentType: "audio/mp3" })).toBe(false);
		expect(isVoiceCompatibleAudio({ fileName: "song.mp3" })).toBe(false);
	});
});

describe("extensionForMime", () => {
	it("returns extension for known MIME types", () => {
		expect(extensionForMime("image/jpeg")).toBe(".jpg");
		expect(extensionForMime("audio/mpeg")).toBe(".mp3");
		expect(extensionForMime("video/mp4")).toBe(".mp4");
	});

	it("returns undefined for null", () => {
		expect(extensionForMime(null)).toBeUndefined();
	});

	it("returns undefined for unknown MIME types", () => {
		expect(extensionForMime("application/x-unknown")).toBeUndefined();
	});
});

describe("imageMimeFromFormat", () => {
	it("returns MIME type for known formats", () => {
		expect(imageMimeFromFormat("jpg")).toBe("image/jpeg");
		expect(imageMimeFromFormat("jpeg")).toBe("image/jpeg");
		expect(imageMimeFromFormat("png")).toBe("image/png");
		expect(imageMimeFromFormat("gif")).toBe("image/gif");
	});

	it("returns undefined for null", () => {
		expect(imageMimeFromFormat(null)).toBeUndefined();
	});

	it("returns undefined for unknown formats", () => {
		expect(imageMimeFromFormat("bmp")).toBeUndefined();
	});
});
