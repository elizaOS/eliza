/**
 * Exercises real catalog/navigation HTTP with trusted turn policy and cancellation.
 * The test server records transport effects; this is not mounted-renderer evidence.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Memory } from "@elizaos/core";
import { runWithStreamingContext } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setNavigationConstraint } from "./navigation-execution.js";
import { createViewsClient, type ViewSummary } from "./views-client.js";
import { runViewsShow } from "./views-show.js";

let server: Server;
let controller: AbortController;
let posts: Record<string, unknown>[];
let cancelCatalog: boolean;
let view: ViewSummary;
let reply: "delivered" | "false" | "missing" | "malformed" | "mismatch";
let previousPort: string | undefined;
const message = {
	id: "turn-1",
	roomId: "room-1",
	entityId: "actor-1",
	content: { text: "Add dentist Thursday 2pm, but do not change views." },
} as unknown as Memory;
const options = {
	view: "calendar",
	navigationIntent: "planner-step",
	navigationStepId: "step-1",
};

beforeEach(async () => {
	controller = new AbortController();
	posts = [];
	cancelCatalog = false;
	reply = "delivered";
	view = {
		id: "calendar",
		label: "Calendar",
		pluginName: "calendar",
		available: true,
	};
	previousPort = process.env.ELIZA_API_PORT;
	server = createServer(async (req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.method === "GET") {
			if (cancelCatalog) controller.abort("superseded while reading catalog");
			res.end(JSON.stringify({ views: [view] }));
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const body: Record<string, unknown> = JSON.parse(
			Buffer.concat(chunks).toString(),
		);
		posts.push(body);
		res.end(
			reply === "malformed"
				? "not JSON"
				: JSON.stringify(
						reply === "missing"
							? {}
							: {
									completedActionDelivered: reply !== "false",
									completedActionHandoffId:
										reply === "mismatch"
											? "other-step"
											: body.completedActionHandoffId,
								},
					),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	process.env.ELIZA_API_PORT = String((server.address() as AddressInfo).port);
});
afterEach(async () => {
	if (previousPort === undefined) delete process.env.ELIZA_API_PORT;
	else process.env.ELIZA_API_PORT = previousPort;
	await new Promise<void>((resolve) => server.close(() => resolve()));
});
function show(extra: Partial<Parameters<typeof runViewsShow>[0]> = {}) {
	return runViewsShow({
		client: createViewsClient(),
		message,
		options,
		originatingClientId: "client-a",
		...extra,
	});
}
function turn<T>(run: () => T, disposition: "allow" | "deny" = "allow"): T {
	return runWithStreamingContext(
		{ messageId: message.id, abortSignal: controller.signal },
		() => {
			setNavigationConstraint(message, disposition, "trusted classification");
			return run();
		},
	);
}

describe("navigation execution policy", () => {
	it("rejects planner arguments that attempt to override a forbidden turn", async () => {
		const result = await turn(() => show(), "deny");
		expect(posts).toEqual([]);
		expect(result.success).toBe(false);
		expect(result.data).toMatchObject({
			navigation: { status: "forbidden", stepId: "step-1" },
		});
	});
	it("keeps a denial when a nested model scope detaches streaming and omits the planner marker", async () => {
		const result = await turn(
			() =>
				runWithStreamingContext(undefined, () =>
					show({ options: { view: "calendar" } }),
				),
			"deny",
		);
		expect(posts).toEqual([]);
		expect(result.data).toMatchObject({ navigation: { status: "forbidden" } });
	});
	it("rejects a planner step without trusted turn policy", async () => {
		const result = await show();
		expect(posts).toEqual([]);
		expect(result.data).toMatchObject({ navigation: { status: "invalid" } });
	});
	it("does not dispatch after cancellation during the real catalog request", async () => {
		cancelCatalog = true;
		const result = await turn(() => show());
		expect(posts).toEqual([]);
		expect(result.data).toMatchObject({
			navigation: { status: "cancelled", stepId: "step-1" },
		});
	});
	it("rechecks cancellation after role resolution", async () => {
		view.roleGate = { minRole: "OWNER" };
		const result = await turn(() =>
			show({
				resolveCallerRoles: async () => {
					await Promise.resolve();
					controller.abort("superseded during authorization");
					return ["OWNER"];
				},
			}),
		);
		expect(posts).toEqual([]);
		expect(result.data).toMatchObject({ navigation: { status: "cancelled" } });
	});
	for (const mode of ["false", "missing", "mismatch", "malformed"] as const) {
		it(`keeps ${mode} client receipt distinct from delivery`, async () => {
			reply = mode;
			const result = await turn(() => show());
			expect(result.data).toMatchObject({
				navigation: {
					status: mode === "malformed" ? "malformed" : "not-delivered",
					stepId: "step-1",
				},
			});
			expect(JSON.parse(result.text ?? "{}").status).toBe(
				mode === "malformed" ? "malformed" : "not-delivered",
			);
			expect(result.values?.completedActionDelivered).toBeUndefined();
		});
	}
	it("reuses originating-client handoff identity when the same turn/step is replayed", async () => {
		const first = await turn(() => show());
		const second = await turn(() => show());
		expect(posts).toHaveLength(2);
		expect(posts[0].clientId).toBe("client-a");
		expect(posts[1].clientId).toBe("client-a");
		expect(posts[0].completedActionHandoffId).toBe(
			posts[1].completedActionHandoffId,
		);
		expect(first.data).toEqual(second.data);
		expect(first.data).toMatchObject({
			navigation: { status: "delivered", stepId: "step-1" },
		});
	});
});
