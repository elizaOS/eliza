/**
 * Owner-private audience resolution preserves the live connector principal
 * when that principal is one of the deployment's configured owner contacts.
 */
import { describe, expect, it } from "vitest";
import { resolveCanonicalOwnerIdForMessage } from "./roles.ts";
import type { IAgentRuntime, Memory, UUID } from "./types/index.ts";

const CANONICAL = "00000000-0000-0000-0000-000000000001" as UUID;
const TELEGRAM = "00000000-0000-0000-0000-000000000002" as UUID;

describe("resolveCanonicalOwnerIdForMessage", () => {
	it("uses the current configured connector owner for its private audience", async () => {
		const runtime = {
			getSetting: (key: string) => {
				if (key === "ELIZA_ADMIN_ENTITY_ID") return CANONICAL;
				if (key === "ELIZA_OWNER_CONTACTS_JSON") {
					return JSON.stringify({ telegram: { entityId: TELEGRAM } });
				}
				return undefined;
			},
		} as unknown as IAgentRuntime;
		const message = { entityId: TELEGRAM } as Memory;

		expect(await resolveCanonicalOwnerIdForMessage(runtime, message)).toBe(
			TELEGRAM,
		);
	});
});
