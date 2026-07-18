/**
 * Server-side view-manager capability tests at the loopback transport boundary.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appControlPlugin } from "../index.ts";

const originalElizaPort = process.env.ELIZA_PORT;

describe("views-manager server interaction", () => {
	beforeEach(() => {
		process.env.ELIZA_PORT = "3456";
	});

	afterEach(() => {
		if (originalElizaPort === undefined) {
			delete process.env.ELIZA_PORT;
		} else {
			process.env.ELIZA_PORT = originalElizaPort;
		}
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("returns an explicit success contract and scopes discovery to the caller", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						views: [
							{
								id: "notes",
								label: "Notes",
								pluginName: "@elizaos/plugin-simple-views",
								available: true,
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		const declaration = appControlPlugin.views?.find(
			(view) => view.id === "views-manager",
		);
		if (!declaration?.serverInteract) {
			throw new Error("views-manager serverInteract is not registered");
		}

		await expect(
			declaration.serverInteract("list-views", undefined, {
				clientId: "shell-a",
			}),
		).resolves.toMatchObject({
			success: true,
			views: [{ id: "notes", label: "Notes" }],
		});
		const [, init] = fetchMock.mock.calls[0] as [
			RequestInfo | URL,
			RequestInit,
		];
		expect(new Headers(init.headers).get("X-ElizaOS-Client-Id")).toBe(
			"shell-a",
		);
	});
});
