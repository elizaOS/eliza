import { describe, expect, it, mock } from "bun:test";
import { AgentNotReadyError } from "./config-and-auth-rpc";
import type { RuntimeDebugSnapshot } from "./rpc-schema";
import {
	composeRuntimeSnapshot,
	type RuntimeSnapshotReader,
	readRuntimeSnapshotViaHttp,
} from "./runtime-rpc";

function mockFetchJson(status: number, body: unknown) {
	const fetchMock = mock(
		async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response(JSON.stringify(body), { status }),
	);
	const replacement: typeof fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => fetchMock(input, init),
		{ preconnect: globalThis.fetch.preconnect },
	);
	globalThis.fetch = replacement;
	return fetchMock;
}

const runtimeSnapshot = {
	runtimeAvailable: true,
	generatedAt: 1700000000000,
	settings: {
		maxDepth: 10,
		maxArrayLength: 1000,
		maxObjectEntries: 1000,
		maxStringLength: 8000,
	},
	meta: {
		agentId: "agent-1",
		agentState: "running",
		agentName: "Eliza",
		model: "gpt-5.5",
		pluginCount: 1,
		actionCount: 2,
		providerCount: 3,
		evaluatorCount: 4,
		serviceTypeCount: 1,
		serviceCount: 1,
	},
	order: {
		plugins: [{ index: 0, name: "plugin-a", className: "Object", id: null }],
		actions: [{ index: 0, name: "reply", className: "Object", id: "reply" }],
		providers: [{ index: 0, name: "facts", className: "Object", id: "facts" }],
		evaluators: [
			{
				index: 0,
				name: "reflection",
				className: "Object",
				id: "reflection",
			},
		],
		services: [
			{
				index: 0,
				serviceType: "database",
				count: 1,
				instances: [
					{ index: 0, name: "pglite", className: "Object", id: "pglite" },
				],
			},
		],
	},
	sections: {
		runtime: { character: "Eliza" },
		plugins: [],
		actions: [],
		providers: [],
		evaluators: [],
		services: {},
	},
} satisfies RuntimeDebugSnapshot;

describe("getRuntimeSnapshot typed RPC", () => {
	it("throws AgentNotReadyError when port is null", async () => {
		const reader: RuntimeSnapshotReader = async () => runtimeSnapshot;

		await expect(
			composeRuntimeSnapshot(null, undefined, reader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("passes snapshot params to the runtime reader", async () => {
		const reader = mock(async () => runtimeSnapshot);

		await expect(
			composeRuntimeSnapshot(31337, { depth: 4 }, reader),
		).resolves.toEqual(runtimeSnapshot);
		expect(reader).toHaveBeenCalledWith(31337, { depth: 4 });
	});

	it("reads and validates the HTTP runtime snapshot payload", async () => {
		const fetchMock = mockFetchJson(200, runtimeSnapshot);

		await expect(
			readRuntimeSnapshotViaHttp(31337, {
				depth: 4,
				maxArrayLength: 12,
				maxObjectEntries: 13,
				maxStringLength: 14,
			}),
		).resolves.toEqual(runtimeSnapshot);

		const url = String(fetchMock.mock.calls[0]?.[0]);
		expect(url).toContain("/api/runtime?");
		expect(url).toContain("depth=4");
		expect(url).toContain("maxArrayLength=12");
		expect(url).toContain("maxObjectEntries=13");
		expect(url).toContain("maxStringLength=14");
	});

	it("returns null on malformed runtime snapshot payloads", async () => {
		mockFetchJson(200, {
			...runtimeSnapshot,
			meta: {
				...runtimeSnapshot.meta,
				evaluatorCount: "4",
			},
		});

		await expect(readRuntimeSnapshotViaHttp(31337)).resolves.toBeNull();
	});
});
