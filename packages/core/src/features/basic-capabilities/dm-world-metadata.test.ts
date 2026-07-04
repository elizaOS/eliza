import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../../types";
import { buildDmWorldMetadata } from "./index.ts";

/**
 * #12087 Item 2: a DM world grants OWNER only to a configured canonical owner.
 * Without this guard every DM sender is written as OWNER of their own DM world,
 * so with no canonical owner configured (the default) anyone who could DM the
 * agent clears every minRole:OWNER gate (SECRETS, SHELL, …).
 */

function runtimeWith(settings: Record<string, string>): IAgentRuntime {
	return {
		getSetting: (key: string) => settings[key],
	} as unknown as IAgentRuntime;
}

const OWNER = "11111111-1111-1111-1111-111111111111";
const STRANGER = "22222222-2222-2222-2222-222222222222";

describe("buildDmWorldMetadata (#12087 Item 2)", () => {
	it("default config: a DM sender gets NO owner grant", () => {
		const meta = buildDmWorldMetadata(runtimeWith({}), STRANGER);
		expect(meta.ownership).toBeUndefined();
		expect(meta.roles).toBeUndefined();
		expect(meta.roleSources).toBeUndefined();
		expect(meta.settings).toEqual({});
	});

	it("a configured owner DMing the agent is granted OWNER (auditable)", () => {
		const runtime = runtimeWith({ ELIZA_ADMIN_ENTITY_ID: OWNER });
		const meta = buildDmWorldMetadata(runtime, OWNER);
		expect(meta.ownership).toEqual({ ownerId: OWNER });
		expect(meta.roles).toEqual({ [OWNER]: "OWNER" });
		// #9948 auditable grant: roles is paired with roleSources.
		expect(meta.roleSources).toEqual({ [OWNER]: "owner" });
	});

	it("a non-owner DM sender gets no grant even when an owner is configured", () => {
		const runtime = runtimeWith({ ELIZA_ADMIN_ENTITY_ID: OWNER });
		const meta = buildDmWorldMetadata(runtime, STRANGER);
		expect(meta.ownership).toBeUndefined();
		expect(meta.roles).toBeUndefined();
	});

	it("honors an owner declared via ELIZA_OWNER_CONTACTS_JSON", () => {
		const runtime = runtimeWith({
			ELIZA_OWNER_CONTACTS_JSON: JSON.stringify({
				telegram: { entityId: OWNER },
			}),
		});
		expect(buildDmWorldMetadata(runtime, OWNER).roles).toEqual({
			[OWNER]: "OWNER",
		});
		expect(buildDmWorldMetadata(runtime, STRANGER).roles).toBeUndefined();
	});
});
