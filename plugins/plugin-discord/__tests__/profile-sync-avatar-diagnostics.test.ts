/**
 * Pins the failure diagnostic of Discord profile-avatar resolution.
 *
 * The avatar source is probed against several local roots. When every probe
 * misses, the reported error must name the SOURCE and the paths tried — not
 * one arbitrary candidate's ENOENT, which sends a reader hunting for a single
 * file that was never the real input. The aggregate must not overreach either:
 * a candidate that failed for any reason OTHER than absence exists as far as
 * the probe loop knows, so summarizing it as nonexistence trades one fabricated
 * diagnosis for another. Deterministic: a duck-typed clientUser, a minimal fake
 * runtime, and a real temp directory for the unreadable case; no Discord
 * client, network, or model.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { afterAll, describe, expect, it } from "vitest";
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
	username: "eliza",
	setAvatar: async () => undefined,
	setUsername: async () => undefined,
};

const tempDirectories: string[] = [];

afterAll(async () => {
	await Promise.all(
		tempDirectories.map((directory) =>
			fs.rm(directory, { recursive: true, force: true }),
		),
	);
});

describe("Discord profile avatar resolution diagnostics", () => {
	it("names the source and every candidate path when none resolve", async () => {
		// A web path served from blob storage in cloud — there is no local file
		// for it on a self-hosted box, which is exactly the live case.
		const settings = {
			syncProfile: true,
			profileAvatar: "/avatars/does-not-exist-anywhere.png",
		} as unknown as DiscordSettings;

		const error = await syncDiscordClientProfile(
			fakeRuntime(undefined),
			clientUser,
			settings,
		).then(
			() => null,
			(e: unknown) => e,
		);

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		// The input the caller actually supplied.
		expect(message).toContain("/avatars/does-not-exist-anywhere.png");
		// Evidence that a SET of paths was probed, so nobody chases one file.
		expect(message).toContain("candidate path(s)");
		// The old behaviour rethrew a bare fs error naming a single path.
		expect(message).not.toMatch(/^ENOENT/);
	});

	it("does not report an unreadable candidate as nonexistent", async () => {
		// A directory at the resolved path exists but cannot be read as a file
		// (EISDIR). Before this fix the probe loop swallowed the errno and the
		// aggregate claimed "none of N candidate path(s) exist" — nonexistence
		// asserted about a path that is demonstrably there.
		const directory = await fs.mkdtemp(
			path.join(os.tmpdir(), "discord-avatar-probe-"),
		);
		tempDirectories.push(directory);
		const settings = {
			syncProfile: true,
			profileAvatar: directory,
		} as unknown as DiscordSettings;

		const error = await syncDiscordClientProfile(
			fakeRuntime(undefined),
			clientUser,
			settings,
		).then(
			() => null,
			(e: unknown) => e,
		);

		// The absence claim must NOT be made about a path that is right there.
		const message = (error as Error).message;
		expect(message).not.toContain("candidate path(s) exist");
		expect(message).toContain("other than absence");

		expect(error).toBeInstanceOf(ElizaError);
		const elizaError = error as ElizaError;
		expect(elizaError.code).toBe("DISCORD_PROFILE_AVATAR_UNREADABLE");
		// The errno that actually explains the failure survives as the cause.
		expect((elizaError.cause as NodeJS.ErrnoException | undefined)?.code).toBe(
			"EISDIR",
		);
		expect(elizaError.context?.source).toBe(directory);
	});

	it("carries a typed code and the underlying cause when every probe misses", async () => {
		const settings = {
			syncProfile: true,
			profileAvatar: "/avatars/does-not-exist-anywhere.png",
		} as unknown as DiscordSettings;

		const error = await syncDiscordClientProfile(
			fakeRuntime(undefined),
			clientUser,
			settings,
		).then(
			() => null,
			(e: unknown) => e,
		);

		expect(error).toBeInstanceOf(ElizaError);
		const elizaError = error as ElizaError;
		expect(elizaError.code).toBe("DISCORD_PROFILE_AVATAR_NOT_FOUND");
		expect((elizaError.cause as NodeJS.ErrnoException | undefined)?.code).toBe(
			"ENOENT",
		);
		expect(Array.isArray(elizaError.context?.candidates)).toBe(true);
	});

	it("leaves the avatar untouched when profile sync is disabled", async () => {
		let called = false;
		const settings = { syncProfile: false } as unknown as DiscordSettings;
		await syncDiscordClientProfile(
			fakeRuntime("/avatars/does-not-exist-anywhere.png"),
			{
				...clientUser,
				setAvatar: async () => {
					called = true;
				},
			},
			settings,
		);
		expect(called).toBe(false);
	});
});
