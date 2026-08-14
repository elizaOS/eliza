/**
 * Pins the failure diagnostic of Discord profile-avatar resolution.
 *
 * The avatar source is probed against several local roots. When every probe
 * misses, the reported error must name the SOURCE and the paths tried — not
 * one arbitrary candidate's ENOENT, which sends a reader hunting for a single
 * file that was never the real input. Deterministic: a duck-typed clientUser
 * and a minimal fake runtime; no Discord client, network, or model.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
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
