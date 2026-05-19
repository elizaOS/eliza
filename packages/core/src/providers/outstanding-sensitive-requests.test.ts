import { describe, expect, test } from "vitest";
import { outstandingSensitiveRequestsProvider } from "./outstanding-sensitive-requests";

const message = {
	entityId: "user-1",
	roomId: "room-1",
	content: { text: "" },
};

describe("OUTSTANDING_SENSITIVE_REQUESTS provider", () => {
	test("returns outstanding requests from the client", async () => {
		const client = {
			listOutstanding: async () => [
				{ id: "r-1", kind: "secret", key: "ANTHROPIC_API_KEY" },
				{ id: "r-2", kind: "oauth", pluginName: "discord" },
			],
		};
		const runtime = {
			agentId: "agent-1",
			getService: (name: string) =>
				name === "SensitiveRequestsClient" ? client : null,
		};

		const result = await outstandingSensitiveRequestsProvider.get(
			runtime as never,
			message as never,
			{} as never,
		);

		const data = result.data as { requests: Array<{ id: string }> };
		expect(data.requests).toHaveLength(2);
		expect(data.requests.map((r) => r.id)).toEqual(["r-1", "r-2"]);
	});

	test("returns empty list when client service is absent", async () => {
		const runtime = { agentId: "agent-1", getService: () => null };
		const result = await outstandingSensitiveRequestsProvider.get(
			runtime as never,
			message as never,
			{} as never,
		);
		const data = result.data as { requests: unknown[] };
		expect(data.requests).toEqual([]);
		expect(result.text).toBe("");
	});
});
