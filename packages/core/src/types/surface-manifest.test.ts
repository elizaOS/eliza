/**
 * Exercises the surface-manifest resolver — the wallpaper-grant gate and the
 * manifest-over-legacy precedence that keeps a view from opting into the shared
 * wallpaper by accident (#13452). Pure deterministic logic; no harness.
 */

import { describe, expect, it } from "vitest";
import {
	IMMERSIVE_WALLPAPER_SURFACE,
	resolveSurfaceBackgroundPolicy,
	resolveSurfaceManifest,
	SURFACE_CAPABILITIES,
	type SurfaceManifest,
	type SurfaceManifestBearer,
	surfaceGrants,
} from "./surface-manifest";

describe("resolveSurfaceManifest — defaults", () => {
	it("fills the safe default for a null/empty declaration", () => {
		for (const decl of [
			null,
			undefined,
			{},
		] as (SurfaceManifestBearer | null)[]) {
			const m = resolveSurfaceManifest(decl);
			expect(m.background).toBe("opaque");
			expect(m.header).toBe("normal");
			expect(m.isolation).toBe("in-process");
			expect(m.lifecycle).toBe("ephemeral");
			expect(m.layout).toEqual({
				kind: "content",
				topology: "framed",
				width: "standard",
				scroll: "view",
				gutter: "standard",
			});
			expect(m.capabilities.size).toBe(0);
		}
	});

	it("de-duplicates granted capabilities into a set", () => {
		const m = resolveSurfaceManifest({
			surface: {
				capabilities: ["navigate", "navigate", "storage"],
			},
		});
		expect(m.capabilities.size).toBe(2);
		expect(m.capabilities.has("navigate")).toBe(true);
		expect(m.capabilities.has("storage")).toBe(true);
	});
});

describe("resolveSurfaceManifest — page topology", () => {
	it("keeps content semantics independent from scroll ownership", () => {
		for (const scroll of ["shell", "view"] as const) {
			expect(
				resolveSurfaceManifest({
					surface: {
						layout: { kind: "content", width: "reading", scroll },
					},
				}).layout.scroll,
			).toBe(scroll);
		}
	});

	it("preserves a declared workspace layout without mixing header or isolation policy", () => {
		const m = resolveSurfaceManifest({
			surface: {
				header: "fullscreen",
				isolation: "native-webview",
				layout: { kind: "workspace", width: "full", scroll: "view" },
			},
		});

		expect(m.layout).toEqual({
			kind: "workspace",
			topology: "framed",
			width: "full",
			scroll: "view",
		});
		expect(m.header).toBe("fullscreen");
		expect(m.isolation).toBe("native-webview");
	});

	it("preserves explicit ambient topology while defaulting omissions to framed", () => {
		expect(
			resolveSurfaceManifest({
				surface: {
					layout: {
						kind: "immersive",
						topology: "ambient",
						width: "full",
						scroll: "view",
						gutter: "none",
					},
				},
			}).layout.topology,
		).toBe("ambient");
	});
});

describe("resolveSurfaceManifest — wallpaper grant gate", () => {
	it("forces opaque when a view declares shared without the wallpaper grant", () => {
		const m = resolveSurfaceManifest({
			surface: { background: "shared", capabilities: [] },
		});
		expect(m.background).toBe("opaque");
	});

	it("forces opaque when shared is declared with unrelated grants only", () => {
		const m = resolveSurfaceManifest({
			surface: {
				background: "shared",
				capabilities: ["navigate", "storage", "agent-surface"],
			},
		});
		expect(m.background).toBe("opaque");
	});

	it("honours shared only when the wallpaper grant is present", () => {
		const m = resolveSurfaceManifest({
			surface: { background: "shared", capabilities: ["wallpaper"] },
		});
		expect(m.background).toBe("shared");
	});

	it("gates the legacy standalone backgroundPolicy through the same grant check", () => {
		// A legacy declaration (no manifest) that says shared but never granted
		// wallpaper is now forced opaque — the accidental-opt-in path is closed
		// even for pre-manifest declarations.
		const legacyShared: SurfaceManifestBearer = { backgroundPolicy: "shared" };
		expect(resolveSurfaceBackgroundPolicy(legacyShared)).toBe("opaque");

		// A legacy declaration paired with an explicit manifest grant resolves
		// shared — the grant is the single switch that admits the wallpaper.
		const legacyPlusGrant: SurfaceManifestBearer = {
			backgroundPolicy: "shared",
			surface: { capabilities: ["wallpaper"] },
		};
		expect(resolveSurfaceBackgroundPolicy(legacyPlusGrant)).toBe("shared");
	});

	it("opaque declarations are never promoted to shared regardless of grant", () => {
		const m = resolveSurfaceManifest({
			surface: { background: "opaque", capabilities: ["wallpaper"] },
		});
		expect(m.background).toBe("opaque");
	});
});

describe("resolveSurfaceManifest — manifest over legacy precedence", () => {
	it("prefers surface.background over legacy backgroundPolicy", () => {
		// Manifest says opaque (no grant), legacy says shared: manifest wins → opaque.
		const m = resolveSurfaceManifest({
			surface: { background: "opaque" },
			backgroundPolicy: "shared",
		});
		expect(m.background).toBe("opaque");
	});

	it("prefers surface.header over legacy headerPolicy", () => {
		const m = resolveSurfaceManifest({
			surface: { header: "fullscreen" },
			headerPolicy: "modal",
		});
		expect(m.header).toBe("fullscreen");
	});

	it("falls back to legacy headerPolicy when the manifest omits header", () => {
		const m = resolveSurfaceManifest({
			surface: { capabilities: ["navigate"] },
			headerPolicy: "modal",
		});
		expect(m.header).toBe("modal");
	});
});

describe("surfaceGrants", () => {
	it("returns true only for granted capabilities", () => {
		const m = resolveSurfaceManifest({
			surface: { capabilities: ["navigate", "storage"] },
		});
		expect(surfaceGrants(m, "navigate")).toBe(true);
		expect(surfaceGrants(m, "storage")).toBe(true);
		expect(surfaceGrants(m, "wallpaper")).toBe(false);
		expect(surfaceGrants(m, "background:apply")).toBe(false);
		expect(surfaceGrants(m, "agent-surface")).toBe(false);
	});
});

describe("IMMERSIVE_WALLPAPER_SURFACE", () => {
	it("is the one place that pairs shared background with the wallpaper grant", () => {
		const m = resolveSurfaceManifest({
			surface: IMMERSIVE_WALLPAPER_SURFACE,
		});
		expect(m.background).toBe("shared");
		expect(m.header).toBe("immersive");
		expect(m.isolation).toBe("immersive");
		expect(surfaceGrants(m, "wallpaper")).toBe(true);
		expect(surfaceGrants(m, "background:apply")).toBe(true);
	});
});

describe("catalogue constants", () => {
	it("every constant capability round-trips through a manifest", () => {
		const all: SurfaceManifest = { capabilities: SURFACE_CAPABILITIES };
		const m = resolveSurfaceManifest({ surface: all });
		for (const cap of SURFACE_CAPABILITIES) {
			expect(surfaceGrants(m, cap)).toBe(true);
		}
	});
});
