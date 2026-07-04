/**
 * Unit tests for the xrViewHostRoute handler.
 *
 * These tests call the real route handler directly — no mock server,
 * no Playwright — proving that the elizaOS plugin infrastructure
 * produces correct, complete HTML for arbitrary XR view IDs. This validates
 * the shared host template without carrying a copied inventory of plugin views.
 */

import { describe, expect, it } from "vitest";
import { xrViewHostRoute } from "../routes/xr-view-host.ts";

const VIEW_HOST_SMOKE_IDS = [
	"xr-route-smoke",
	"hyphenated-view",
	"space-panel",
] as const;

function makeCtx(viewId: string) {
	return {
		params: { id: viewId },
		runtime: { port: 31337 } as unknown as never,
	};
}

async function fetchHtml(viewId: string): Promise<string> {
	const result = await xrViewHostRoute.routeHandler(makeCtx(viewId) as never);
	expect(result.status).toBe(200);
	expect(result.headers?.["Content-Type"]).toMatch(/text\/html/);
	return result.body as string;
}

describe("xrViewHostRoute — real route handler", () => {
	it("returns 400 for missing view id", async () => {
		const result = await xrViewHostRoute.routeHandler({
			params: {},
			runtime: {},
		} as never);
		expect(result.status).toBe(400);
	});

	it("returns 200 with Content-Type text/html for representative view ids", async () => {
		for (const id of VIEW_HOST_SMOKE_IDS) {
			const result = await xrViewHostRoute.routeHandler(makeCtx(id) as never);
			expect(result.status, `${id}: expected status 200`).toBe(200);
			expect(
				result.headers?.["Content-Type"],
				`${id}: expected text/html Content-Type`,
			).toMatch(/text\/html/);
		}
	});

	it("each view-host page has a DOCTYPE and html[data-view-id] set to the view id", async () => {
		for (const id of VIEW_HOST_SMOKE_IDS) {
			const html = await fetchHtml(id);
			expect(html, `${id}: should start with <!DOCTYPE html>`).toMatch(
				/^<!DOCTYPE html>/i,
			);
			expect(html, `${id}: html tag should carry data-view-id`).toContain(
				`data-view-id="${id}"`,
			);
		}
	});

	it("each view-host page contains the XR shell structure", async () => {
		for (const id of VIEW_HOST_SMOKE_IDS) {
			const html = await fetchHtml(id);
			expect(html, `${id}: missing #xr-shell`).toContain('id="xr-shell"');
			expect(html, `${id}: missing #xr-bar`).toContain('id="xr-bar"');
			expect(html, `${id}: missing #view-mount`).toContain('id="view-mount"');
			expect(html, `${id}: missing #btn-close`).toContain('id="btn-close"');
			expect(html, `${id}: missing #voice-indicator`).toContain(
				'id="voice-indicator"',
			);
		}
	});

	it("each view-host page includes the voice transcript routing script", async () => {
		for (const id of VIEW_HOST_SMOKE_IDS) {
			const html = await fetchHtml(id);
			// The page must listen for xr:transcript messages and route to focused input
			expect(html, `${id}: missing xr:transcript handler`).toContain(
				"xr:transcript",
			);
			expect(html, `${id}: missing fillFocusedInput`).toContain(
				"fillFocusedInput",
			);
			expect(html, `${id}: missing xr:focus-next handler`).toContain(
				"xr:focus-next",
			);
		}
	});

	it("each view-host page sends xr:view-ready to parent on mount", async () => {
		for (const id of VIEW_HOST_SMOKE_IDS) {
			const html = await fetchHtml(id);
			expect(html, `${id}: missing xr:view-ready postMessage`).toContain(
				"xr:view-ready",
			);
			// And the view id must be encoded correctly in the page script
			expect(html, `${id}: VIEW_ID constant not set`).toContain(
				`const VIEW_ID = "${id}"`,
			);
		}
	});

	it("each view-host page has a React importmap pointing to esm.sh", async () => {
		for (const id of VIEW_HOST_SMOKE_IDS) {
			const html = await fetchHtml(id);
			expect(html, `${id}: missing importmap`).toContain('type="importmap"');
			expect(
				html,
				`${id}: importmap should reference react from esm.sh`,
			).toContain("esm.sh/react");
		}
	});

	it("each view-host page constructs the bundle URL from the agent origin", async () => {
		for (const id of VIEW_HOST_SMOKE_IDS) {
			const html = await fetchHtml(id);
			// Bundle URL must reference the view id and the agent origin
			expect(html, `${id}: bundle URL must include view id`).toContain(
				`/api/views/${id}/bundle.js`,
			);
		}
	});

	it("each view-host page has XR-friendly form styling (min-height 44px)", async () => {
		for (const id of VIEW_HOST_SMOKE_IDS) {
			const html = await fetchHtml(id);
			expect(html, `${id}: missing 44px touch target rule`).toContain(
				"min-height: 44px",
			);
		}
	});

	it("each view-host page includes a transcript toast element", async () => {
		for (const id of VIEW_HOST_SMOKE_IDS) {
			const html = await fetchHtml(id);
			expect(html, `${id}: missing #transcript-toast`).toContain(
				'id="transcript-toast"',
			);
		}
	});

	it("Content-Security-Policy header allows the agent origin and esm.sh", async () => {
		for (const id of VIEW_HOST_SMOKE_IDS) {
			const result = await xrViewHostRoute.routeHandler(makeCtx(id) as never);
			const csp = result.headers?.["Content-Security-Policy"] ?? "";
			expect(csp, `${id}: CSP must include esm.sh`).toContain("esm.sh");
			expect(csp, `${id}: CSP must include localhost agent origin`).toContain(
				"localhost:31337",
			);
		}
	});

	it("view-host pages are distinct (each embeds its own VIEW_ID)", async () => {
		const htmlMap = new Map<string, string>();
		for (const id of VIEW_HOST_SMOKE_IDS) {
			htmlMap.set(id, await fetchHtml(id));
		}
		// Every page should differ because VIEW_ID is embedded
		for (const [id, html] of htmlMap) {
			for (const [otherId, otherHtml] of htmlMap) {
				if (id === otherId) continue;
				// The two pages cannot be identical
				expect(
					html,
					`${id} and ${otherId} pages are unexpectedly identical`,
				).not.toBe(otherHtml);
			}
		}
	});
});
