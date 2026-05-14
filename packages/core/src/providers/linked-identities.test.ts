import { describe, expect, test } from "vitest";
import { linkedIdentitiesProvider } from "./linked-identities";

const message = {
	entityId: "user-1",
	roomId: "room-1",
	content: { text: "" },
};

describe("LINKED_IDENTITIES provider", () => {
	test("returns linked identities from the client", async () => {
		const client = {
			listLinkedIdentities: async () => [
				{ identityId: "g-1", provider: "github", verified: true },
				{ identityId: "d-1", provider: "discord", verified: false },
			],
		};
		const runtime = {
			agentId: "agent-1",
			getService: (name: string) =>
				name === "IdentityLinkClient" ? client : null,
		};

		const result = await linkedIdentitiesProvider.get(
			runtime as never,
			message as never,
			{} as never,
		);

		const data = result.data as { identities: Array<{ provider: string }> };
		expect(data.identities).toHaveLength(2);
		expect(data.identities.map((i) => i.provider)).toEqual([
			"github",
			"discord",
		]);
	});

	test("returns empty list when client service is absent", async () => {
		const runtime = { agentId: "agent-1", getService: () => null };
		const result = await linkedIdentitiesProvider.get(
			runtime as never,
			message as never,
			{} as never,
		);
		const data = result.data as { identities: unknown[] };
		expect(data.identities).toEqual([]);
		expect(result.text).toBe("");
	});
});
