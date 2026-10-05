/**
 * Verifies the desktop credential-delivery contract of api-base-owner: the
 * static-server HTML inject seeds the renderer boot config with the API base
 * only and must never embed the OWNER bearer token — the static server is
 * reachable by any local process, and a token in a served document would hand
 * the app's highest-privilege credential to anything that can read the page
 * (elizaOS/eliza#33034). The token must instead arrive through the typed
 * Electrobun RPC push. Deterministic harness: pure module state plus a
 * recording fake window; the real `pushApiBaseToRenderer` implementation runs.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as apiBaseOwner from "./api-base-owner";

const TEST_BASE = "http://127.0.0.1:31337";
const TEST_TOKEN = "a1b2c3d4e5f6ownercredential";

type RecordingWindow = {
	webview: {
		rpc: {
			send: {
				apiBaseUpdate: (payload: {
					base: string;
					token?: string;
					externalApiBase?: string | null;
					localApiBase?: string | null;
				}) => void;
			};
		};
	};
};

function recordingWindow(): {
	window: RecordingWindow;
	payloads: Array<{
		base: string;
		token?: string;
		externalApiBase?: string | null;
		localApiBase?: string | null;
	}>;
} {
	const payloads: Array<{
		base: string;
		token?: string;
		externalApiBase?: string | null;
		localApiBase?: string | null;
	}> = [];
	const window: RecordingWindow = {
		webview: {
			rpc: {
				send: {
					apiBaseUpdate: (payload) => {
						payloads.push(payload);
					},
				},
			},
		},
	};
	return { window, payloads };
}

afterEach(() => {
	apiBaseOwner.setCurrent(null, "");
});

describe("apiBaseOwner.injectIntoHtml token confinement", () => {
	it("seeds the boot config with the API base but never the bearer token", () => {
		apiBaseOwner.setCurrent(TEST_BASE, TEST_TOKEN);
		const result = apiBaseOwner.injectIntoHtml(
			"<html><head></head><body></body></html>",
		);
		expect(result).toContain(TEST_BASE);
		expect(result).not.toContain(TEST_TOKEN);
		expect(result).not.toContain("apiToken");
	});

	it("keeps served documents credential-free for every supported HTML shape", () => {
		apiBaseOwner.setCurrent(TEST_BASE, TEST_TOKEN);
		for (const html of [
			"<html><head><title>t</title></head><body></body></html>",
			"<html><body><div>no head element</div></body></html>",
			"<div>neither head nor body markers</div>",
		]) {
			const result = apiBaseOwner.injectIntoHtml(html);
			expect(result).not.toContain(TEST_TOKEN);
			expect(result).not.toContain("apiToken");
		}
	});
});

describe("apiBaseOwner RPC token delivery", () => {
	it("pushes base and token together over the typed RPC bridge", () => {
		const { window, payloads } = recordingWindow();
		apiBaseOwner.setCurrent(TEST_BASE, TEST_TOKEN);
		apiBaseOwner.pushToWindow(window);
		expect(payloads).toHaveLength(1);
		expect(payloads[0]?.base).toBe(TEST_BASE);
		expect(payloads[0]?.token).toBe(TEST_TOKEN);
	});

	it("still pushes the token after notifyChange re-publishes a shifted port", () => {
		const { window, payloads } = recordingWindow();
		apiBaseOwner.notifyChange(window, "http://127.0.0.1:2139", TEST_TOKEN);
		expect(payloads).toHaveLength(1);
		expect(payloads[0]?.base).toBe("http://127.0.0.1:2139");
		expect(payloads[0]?.token).toBe(TEST_TOKEN);
	});
});
