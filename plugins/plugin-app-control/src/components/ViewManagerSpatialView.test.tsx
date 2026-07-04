/**
 * Spatial view-manager render tests for TUI and XR surface output.
 */

import { visibleWidth } from "@elizaos/tui";
import { SpatialSurface } from "@elizaos/ui/spatial";
import {
	getTerminalView,
	registerSpatialTerminalView,
	renderViewToLines,
} from "@elizaos/ui/spatial/tui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ViewEntry } from "../views/viewManagerData.ts";
import {
	type ViewManagerSnapshot,
	ViewManagerSpatialView,
} from "./ViewManagerSpatialView.tsx";

const views: ViewEntry[] = [
	{
		id: "wallet",
		label: "Wallet",
		viewType: "gui",
		path: "/wallet",
		available: true,
		pluginName: "@elizaos/plugin-wallet-ui",
	},
	{
		id: "messages",
		label: "Messages",
		viewType: "tui",
		path: "/messages/tui",
		available: false,
		pluginName: "@elizaos/plugin-messages",
	},
	{
		id: "feed",
		label: "Feed",
		viewType: "xr",
		path: "/feed",
		available: true,
		pluginName: "@elizaos/plugin-feed",
	},
];

const snapshot: ViewManagerSnapshot = { views };

const view = <ViewManagerSpatialView snapshot={snapshot} />;

describe("ViewManagerSpatialView one source, three modalities", () => {
	it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
		for (const width of [54, 32]) {
			const lines = renderViewToLines(view, width);
			for (const line of lines) expect(visibleWidth(line)).toBe(width);
			const flat = lines.join("\n");
			expect(flat).toContain("ready");
			expect(flat).toContain("Wallet");
			expect(flat).toContain("Messages");
			expect(flat).toContain("missing");
		}
	});

	it("GUI + XR: renders DOM with agent hooks + per-row open control, XR scaled up", () => {
		const gui = renderToStaticMarkup(
			<SpatialSurface modality="gui">{view}</SpatialSurface>,
		);
		const xr = renderToStaticMarkup(
			<SpatialSurface modality="xr">{view}</SpatialSurface>,
		);
		expect(gui).toContain('data-spatial-surface="gui"');
		expect(xr).toContain('data-spatial-surface="xr"');
		for (const html of [gui, xr]) {
			expect(html).toContain("Wallet");
			expect(html).toContain("Messages");
			// Row is addressable; the open:<id> Button drives navigation.
			expect(html).toContain('data-agent-id="open-wallet"');
			expect(html).toContain('data-agent-id="open:wallet"');
			// Per-view open/available state renders on each row.
			expect(html).toContain("ready");
			expect(html).toContain("missing");
		}
	});

	it("collapses duplicate gui/xr/tui declarations of one id to a single row with chips", () => {
		const dupSnapshot: ViewManagerSnapshot = {
			views: [
				{
					id: "phone",
					label: "Phone",
					viewType: "gui",
					path: "/phone",
					available: true,
					pluginName: "@elizaos/plugin-phone",
				},
				{
					id: "phone",
					label: "Phone XR",
					viewType: "xr",
					path: "/phone",
					available: true,
					pluginName: "@elizaos/plugin-phone",
				},
			],
		};
		const gui = renderToStaticMarkup(
			<SpatialSurface modality="gui">
				<ViewManagerSpatialView snapshot={dupSnapshot} />
			</SpatialSurface>,
		);
		// One collapsed row -> one open control, the gui base label, both surfaces.
		expect(gui.match(/data-agent-id="open:phone"/g)).toHaveLength(1);
		expect(gui).toContain("Phone");
		expect(gui).not.toContain("Phone XR");
	});

	it("registers as a terminal view the agent terminal can mount and render", () => {
		const unregister = registerSpatialTerminalView(
			"views-manager-test",
			() => view,
		);
		try {
			const component = getTerminalView("views-manager-test");
			expect(component).toBeTruthy();
			const lines = component?.render(50) ?? [];
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) expect(visibleWidth(line)).toBe(50);
			expect(lines.join("\n")).toContain("Wallet");
		} finally {
			unregister();
		}
	});
});
