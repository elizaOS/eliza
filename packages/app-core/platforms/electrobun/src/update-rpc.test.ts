import { describe, expect, it, mock } from "bun:test";
import { AgentNotReadyError } from "./config-and-auth-rpc";
import type { AgentUpdateStatusSnapshot } from "./rpc-schema";
import {
	composeUpdateStatusSnapshot,
	readUpdateStatusViaHttp,
	type UpdateStatusReader,
} from "./update-rpc";

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

const updateStatus = {
	currentVersion: "2.0.0",
	channel: "beta",
	installMethod: "git",
	updateAvailable: true,
	latestVersion: "2.1.0",
	channels: {
		stable: "2.0.0",
		beta: "2.1.0",
		nightly: null,
	},
	distTags: {
		stable: "latest",
		beta: "beta",
		nightly: "nightly",
	},
	lastCheckAt: "2026-05-12T00:00:00.000Z",
	error: null,
} satisfies AgentUpdateStatusSnapshot;

describe("getUpdateStatus typed RPC", () => {
	it("throws AgentNotReadyError when port is null", async () => {
		const reader: UpdateStatusReader = async () => updateStatus;

		await expect(
			composeUpdateStatusSnapshot(null, false, reader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("passes the force flag to the update reader", async () => {
		const reader = mock(async (_port: number, force: boolean) => ({
			...updateStatus,
			updateAvailable: force,
		}));

		const result = await composeUpdateStatusSnapshot(31337, true, reader);

		expect(result.updateAvailable).toBe(true);
		expect(reader).toHaveBeenCalledWith(31337, true);
	});

	it("reads and validates the HTTP update status payload", async () => {
		const fetchMock = mockFetchJson(200, updateStatus);

		await expect(readUpdateStatusViaHttp(31337, true)).resolves.toEqual(
			updateStatus,
		);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
			"/api/update/status?force=true",
		);
	});

	it("returns null on malformed update status payloads", async () => {
		mockFetchJson(200, {
			...updateStatus,
			channel: "dev",
		});

		await expect(readUpdateStatusViaHttp(31337, false)).resolves.toBeNull();
	});
});
