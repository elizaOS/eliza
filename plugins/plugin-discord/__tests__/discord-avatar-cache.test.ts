/**
 * Unit tests for Discord avatar caching: validates URL filtering, bounded
 * streaming downloads, Content-Length guards, timeout deadlines, and cache
 * hit/miss semantics.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import {
	cacheDiscordAvatarUrl,
	isDiscordAvatarUrl,
} from "../discord-avatar-cache";

const tempDirs: string[] = [];

describe("discord-avatar-cache", () => {
	let testCacheDir: string;

	beforeEach(async () => {
		testCacheDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "discord-avatar-test-"),
		);
		tempDirs.push(testCacheDir);
		vi.stubEnv("ELIZA_STATE_DIR", testCacheDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	afterAll(async () => {
		await Promise.all(
			tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
		);
	});

	describe("isDiscordAvatarUrl", () => {
		it("accepts valid Discord CDN and media hosts", () => {
			expect(
				isDiscordAvatarUrl(
					"https://cdn.discordapp.com/avatars/12345/abcdef.png",
				),
			).toBe(true);
			expect(
				isDiscordAvatarUrl(
					"https://media.discordapp.net/avatars/12345/abcdef.jpg",
				),
			).toBe(true);
			expect(
				isDiscordAvatarUrl(
					"https://images-ext-1.discordapp.net/external/xyz/avatar.png",
				),
			).toBe(true);
		});

		it("rejects non-Discord hosts and non-https protocols", () => {
			expect(isDiscordAvatarUrl("http://cdn.discordapp.com/avatar.png")).toBe(
				false,
			);
			expect(isDiscordAvatarUrl("https://evil.com/avatar.png")).toBe(false);
			expect(isDiscordAvatarUrl("not-a-url")).toBe(false);
		});
	});

	describe("cacheDiscordAvatarUrl", () => {
		it("skips non-Discord URLs and returns the input unchanged", async () => {
			const nonDiscordUrl = "https://example.com/avatar.png";
			const result = await cacheDiscordAvatarUrl(nonDiscordUrl);
			expect(result).toBe(nonDiscordUrl);
		});

		it("rejects responses with non-image Content-Type", async () => {
			const avatarUrl = "https://cdn.discordapp.com/avatars/1/test.png";
			const fakeFetch = vi.fn(async () => {
				return new Response("<html>Not Found</html>", {
					status: 200,
					headers: { "Content-Type": "text/html" },
				});
			});

			const result = await cacheDiscordAvatarUrl(avatarUrl, {
				fetchImpl: fakeFetch as unknown as typeof fetch,
			});
			expect(result).toBe(avatarUrl);
		});

		it("rejects responses exceeding MAX_DISCORD_AVATAR_BYTES via Content-Length", async () => {
			const avatarUrl = "https://cdn.discordapp.com/avatars/1/huge.png";
			const fakeFetch = vi.fn(async () => {
				return new Response(new Uint8Array(10), {
					status: 200,
					headers: {
						"Content-Type": "image/png",
						"Content-Length": String(10 * 1024 * 1024), // 10MB > 2MB cap
					},
				});
			});

			const result = await cacheDiscordAvatarUrl(avatarUrl, {
				fetchImpl: fakeFetch as unknown as typeof fetch,
			});
			expect(result).toBe(avatarUrl);
		});

		it("aborts stream if chunked payload exceeds MAX_DISCORD_AVATAR_BYTES", async () => {
			const avatarUrl = "https://cdn.discordapp.com/avatars/1/stream-bomb.png";
			const chunkSize = 1024 * 1024; // 1MB
			let chunkCount = 0;
			const stream = new ReadableStream({
				pull(controller) {
					chunkCount++;
					controller.enqueue(new Uint8Array(chunkSize));
					if (chunkCount > 5) {
						controller.close();
					}
				},
			});

			const fakeFetch = vi.fn(async () => {
				return new Response(stream, {
					status: 200,
					headers: { "Content-Type": "image/png" },
				});
			});

			const result = await cacheDiscordAvatarUrl(avatarUrl, {
				fetchImpl: fakeFetch as unknown as typeof fetch,
			});
			expect(result).toBe(avatarUrl);
		});

		it("caches valid Discord avatar and returns the local public route", async () => {
			const avatarUrl = "https://cdn.discordapp.com/avatars/123/valid.png";
			const fakeImageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
			const fakeFetch = vi.fn(async () => {
				return new Response(fakeImageBytes, {
					status: 200,
					headers: {
						"Content-Type": "image/png",
						"Content-Length": String(fakeImageBytes.byteLength),
					},
				});
			});

			const result = await cacheDiscordAvatarUrl(avatarUrl, {
				fetchImpl: fakeFetch as unknown as typeof fetch,
				userId: "user-123",
			});

			expect(result).toMatch(/^\/api\/avatar\/discord\/user-123-/);
			expect(fakeFetch).toHaveBeenCalledTimes(1);

			// Subsequent call should hit cache without invoking fetch again
			const secondResult = await cacheDiscordAvatarUrl(avatarUrl, {
				fetchImpl: fakeFetch as unknown as typeof fetch,
				userId: "user-123",
			});
			expect(secondResult).toBe(result);
			expect(fakeFetch).toHaveBeenCalledTimes(1);
		});
	});
});
