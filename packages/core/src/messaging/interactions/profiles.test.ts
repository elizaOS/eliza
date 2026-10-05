import { expect, it } from "vitest";
import type { InteractionBlock } from "../../types/interactions";
import { CONVERSATIONAL_INTERACTION_PROFILE } from "./profile-catalog";
import {
	createConnectorInteractionCapabilityProfile,
	negotiateInteractionDelivery,
} from "./profiles";

it("rejects malformed sensitive routing before negotiating a delivery", () => {
	const profile = createConnectorInteractionCapabilityProfile({
		template: CONVERSATIONAL_INTERACTION_PROFILE,
		source: "test",
		accountId: "account",
		targetKind: "dm",
		targetId: "target",
	});
	const block = { kind: "secret" } as InteractionBlock;
	expect(negotiateInteractionDelivery(block, profile).mode).toBe(
		"sensitive-request",
	);
	for (const corrupted of [
		{
			...profile,
			nonSecretFallbacks: [...profile.nonSecretFallbacks, "sensitive-request"],
		},
		{ ...profile, sensitiveFallback: "conversational" },
	]) {
		expect(() =>
			negotiateInteractionDelivery(block, corrupted as typeof profile),
		).toThrow(
			expect.objectContaining({
				code: "INVALID_INTERACTION_CAPABILITY_PROFILE",
			}),
		);
	}
});
