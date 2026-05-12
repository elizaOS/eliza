import { describe, expect, it, mock } from "bun:test";
import { AgentNotReadyError } from "./config-and-auth-rpc";
import {
	composeExtensionStatusSnapshot,
	type ExtensionStatusReader,
	readExtensionStatusViaHttp,
} from "./extension-rpc";
import type { ExtensionStatusSnapshot } from "./rpc-schema";

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

const extensionStatus = {
	relayReachable: true,
	relayPort: 18792,
	extensionPath: "/tmp/extension",
	chromeBuildPath: "/tmp/chrome-build",
	chromePackagePath: null,
	safariWebExtensionPath: "/tmp/safari-web-extension",
	safariAppPath: null,
	safariPackagePath: null,
} satisfies ExtensionStatusSnapshot;

describe("getExtensionStatus typed RPC", () => {
	it("throws AgentNotReadyError when port is null", async () => {
		const reader: ExtensionStatusReader = async () => extensionStatus;

		await expect(
			composeExtensionStatusSnapshot(null, reader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("forwards a valid extension status payload", async () => {
		const reader: ExtensionStatusReader = async () => ({
			...extensionStatus,
			releaseManifest: { version: "1.0.0" },
		});

		const result = await composeExtensionStatusSnapshot(31337, reader);

		expect(result.relayReachable).toBe(true);
		expect(result.releaseManifest).toEqual({ version: "1.0.0" });
	});

	it("reads and validates the HTTP extension status payload", async () => {
		const fetchMock = mockFetchJson(200, extensionStatus);

		await expect(readExtensionStatusViaHttp(31337)).resolves.toEqual(
			extensionStatus,
		);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
			"/api/extension/status",
		);
	});

	it("allows absent optional extension artifact fields", async () => {
		mockFetchJson(200, {
			relayReachable: false,
			relayPort: 18792,
			extensionPath: null,
		});

		await expect(readExtensionStatusViaHttp(31337)).resolves.toEqual({
			relayReachable: false,
			relayPort: 18792,
			extensionPath: null,
		});
	});

	it("returns null on malformed extension status payloads", async () => {
		mockFetchJson(200, {
			...extensionStatus,
			relayPort: "18792",
		});

		await expect(readExtensionStatusViaHttp(31337)).resolves.toBeNull();
	});
});
