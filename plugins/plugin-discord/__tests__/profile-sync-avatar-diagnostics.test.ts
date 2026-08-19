/**
 * Exercises Discord avatar candidate failures without a Discord client or
 * network. Mocked and real filesystem failures distinguish expected path
 * misses from present-but-unreadable candidates while proving diagnostics do
 * not disclose configured sources or resolved local paths.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { syncDiscordClientProfile } from "../profileSync.ts";
import type { DiscordSettings } from "../types.ts";

function fakeRuntime(avatar: string | undefined): IAgentRuntime {
	return {
		agentId: "00000000-0000-0000-0000-000000000001",
		character: avatar ? { settings: { avatar } } : {},
		logger: {
			info: () => {},
			warn: () => {},
			error: () => {},
			debug: () => {},
		},
	} as unknown as IAgentRuntime;
}

const clientUser = {
	username: "Eliza",
	setAvatar: async () => undefined,
	setUsername: async () => undefined,
};

function fsError(code: string, sensitivePath: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: cannot read '${sensitivePath}'`), {
		code,
		path: sensitivePath,
	});
}

const tempDirectories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	await Promise.all(
		tempDirectories.map((directory) =>
			fs.rm(directory, { recursive: true, force: true }),
		),
	);
});

describe("Discord profile avatar resolution diagnostics", () => {
	it.each(["EACCES", "EISDIR", "EMFILE", "EIO"])(
		"preserves %s as a read failure without probing or disclosing more paths",
		async (code) => {
			const source = "/private/customer/secret-avatar.png";
			const readFile = vi
				.spyOn(fs, "readFile")
				.mockRejectedValue(fsError(code, source));

			const error = await syncDiscordClientProfile(
				fakeRuntime(source),
				clientUser,
				{ syncProfile: true } as DiscordSettings,
			).then(
				() => null,
				(value: unknown) => value,
			);

			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(
				"DISCORD_PROFILE_AVATAR_READ_FAILED",
			);
			expect((error as ElizaError).context?.fsCode).toBe(code);
			expect((error as Error).cause).toMatchObject({ code });
			expect(String(error)).not.toContain(source);
			expect(String((error as Error).cause)).not.toContain(source);
			expect(JSON.stringify((error as ElizaError).context)).not.toContain(
				source,
			);
			expect(readFile).toHaveBeenCalledTimes(2);
		},
	);

	it.each(["ENOENT", "ENOTDIR"])(
		"aggregates %s misses without exposing configured or candidate paths",
		async (code) => {
			const source = "/private/customer/missing-avatar.png";
			const readFile = vi
				.spyOn(fs, "readFile")
				.mockRejectedValue(fsError(code, source));

			const error = await syncDiscordClientProfile(
				fakeRuntime(undefined),
				clientUser,
				{ syncProfile: true, profileAvatar: source } as DiscordSettings,
			).then(
				() => null,
				(value: unknown) => value,
			);

			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(
				"DISCORD_PROFILE_AVATAR_NOT_FOUND",
			);
			expect((error as ElizaError).context?.candidateCount).toBeGreaterThan(1);
			expect(readFile.mock.calls.length).toBeGreaterThan(2);
			expect(String(error)).not.toContain(source);
			expect(JSON.stringify((error as ElizaError).context)).not.toContain(
				source,
			);
		},
	);

	it("classifies a real directory candidate as unreadable without disclosing it", async () => {
		const directory = await fs.mkdtemp(
			path.join(os.tmpdir(), "discord-avatar-probe-"),
		);
		tempDirectories.push(directory);

		const error = await syncDiscordClientProfile(
			fakeRuntime(undefined),
			clientUser,
			{ syncProfile: true, profileAvatar: directory } as DiscordSettings,
		).then(
			() => null,
			(value: unknown) => value,
		);

		expect(error).toBeInstanceOf(ElizaError);
		expect((error as ElizaError).code).toBe(
			"DISCORD_PROFILE_AVATAR_READ_FAILED",
		);
		expect((error as ElizaError).context?.fsCode).toBe("EISDIR");
		expect((error as Error).cause).toMatchObject({ code: "EISDIR" });
		expect(String(error)).not.toContain(directory);
		expect(String((error as Error).cause)).not.toContain(directory);
		expect(JSON.stringify((error as ElizaError).context)).not.toContain(
			directory,
		);
	});

	it("leaves the avatar untouched when profile sync is disabled", async () => {
		const setAvatar = vi.fn(async () => undefined);
		await syncDiscordClientProfile(
			fakeRuntime("/private/customer/avatar.png"),
			{ ...clientUser, setAvatar },
			{ syncProfile: false } as DiscordSettings,
		);
		expect(setAvatar).not.toHaveBeenCalled();
	});

	it("rejects remote avatar exceeding MAX_PROFILE_AVATAR_BYTES via Content-Length", async () => {
		const remoteUrl = "https://example.com/huge-avatar.png";
		const runtime = {
			...fakeRuntime(remoteUrl),
			fetch: vi.fn(async () => {
				return new Response(new Uint8Array(10), {
					status: 200,
					headers: {
						"Content-Type": "image/png",
						"Content-Length": String(10 * 1024 * 1024), // 10MB > 8MB cap
					},
				});
			}),
		} as unknown as IAgentRuntime;

		const error = await syncDiscordClientProfile(runtime, clientUser, {
			syncProfile: true,
		} as DiscordSettings).then(
			() => null,
			(value: unknown) => value,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(
			"Discord profile avatar exceeds 8388608 bytes",
		);
	});

	it("aborts remote avatar stream exceeding MAX_PROFILE_AVATAR_BYTES", async () => {
		const remoteUrl = "https://example.com/stream-bomb-avatar.png";
		const chunkSize = 2 * 1024 * 1024; // 2MB
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

		const runtime = {
			...fakeRuntime(remoteUrl),
			fetch: vi.fn(async () => {
				return new Response(stream, {
					status: 200,
					headers: { "Content-Type": "image/png" },
				});
			}),
		} as unknown as IAgentRuntime;

		const error = await syncDiscordClientProfile(runtime, clientUser, {
			syncProfile: true,
		} as DiscordSettings).then(
			() => null,
			(value: unknown) => value,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(
			"Discord profile avatar exceeds 8388608 bytes",
		);
	});
});
