import { describe, expect, it } from "vitest";
import { detectMime, getFileExtension } from "./mime.ts";

describe("getFileExtension", () => {
	it("extracts the extension from plain paths and URLs", () => {
		expect(getFileExtension("photo.JPG")).toBe(".jpg");
		expect(getFileExtension("/tmp/archive.tar.gz")).toBe(".gz");
		expect(getFileExtension("https://example.com/song.mp3")).toBe(".mp3");
		expect(getFileExtension("https://example.com/a/b/photo.PNG?raw=1")).toBe(
			".png",
		);
	});

	it("returns undefined for extensionless URL pathnames", () => {
		// Previously returned "./download" (the whole pathname).
		expect(getFileExtension("https://example.com/download")).toBeUndefined();
		expect(getFileExtension("https://example.com/")).toBeUndefined();
	});

	it("ignores dots in directory names", () => {
		// Previously returned ".2/notes" / ".name/readme".
		expect(getFileExtension("https://example.com/v1.2/notes")).toBeUndefined();
		expect(getFileExtension("/home/user.name/README")).toBeUndefined();
		expect(getFileExtension("/releases/v1.2/notes.txt")).toBe(".txt");
	});

	it("returns undefined for a trailing dot", () => {
		// Previously returned "." for "archive.".
		expect(getFileExtension("archive.")).toBeUndefined();
	});

	it("keeps extension-based mime detection working through detectMime", async () => {
		await expect(
			detectMime({ filePath: "https://example.com/notes.csv" }),
		).resolves.toBe("text/csv");
		// A dotted directory must not smuggle a bogus extension into detection.
		await expect(
			detectMime({
				filePath: "https://example.com/v1.2/notes",
				headerMime: "text/markdown",
			}),
		).resolves.toBe("text/markdown");
	});
});
