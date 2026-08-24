/**
 * Exercises the runtime re-export surface of the canonical type-system barrel
 * (`src/types/index.ts`). The barrel re-exports a small set of runtime values
 * explicitly because bare star exports get tree-shaken away; each helper here
 * is driven through that public path to prove it resolves to a working
 * implementation — prompt composition (`addHeader`, `composePromptFromState`),
 * the legacy XML response parser (`parseKeyValueXml`), view-kind resolution
 * and gating, surface-manifest resolution with the wallpaper gate, and
 * pending-action attention weights. Deterministic assertions with no model or
 * database in the loop.
 */
import { describe, expect, it } from "vitest";
import {
	addHeader,
	composePromptFromState,
	IMMERSIVE_WALLPAPER_SURFACE,
	isAlwaysOnViewKind,
	isViewVisible,
	PENDING_USER_ACTION_WEIGHT,
	parseKeyValueXml,
	resolveSurfaceBackgroundPolicy,
	resolveSurfaceManifest,
	resolveViewKind,
	type State,
	surfaceGrants,
} from "./index";

describe("prompt helpers re-exported through the barrel", () => {
	it("addHeader prepends the header to a non-empty body", () => {
		expect(addHeader("# World Information", "body text")).toBe(
			"# World Information\nbody text\n",
		);
	});

	it("addHeader returns the bare header when the body is empty", () => {
		expect(addHeader("Header", "")).toBe("Header");
	});

	it("addHeader omits an empty header line entirely", () => {
		expect(addHeader("", "Body")).toBe("Body\n");
	});

	it("composePromptFromState interpolates top-level state into the template", () => {
		const state: State = {
			agentName: "Alice",
			values: {},
			data: {},
			text: "",
		};
		expect(
			composePromptFromState({ state, template: "Hello, {{agentName}}!" }),
		).toBe("Hello, Alice!");
	});

	it("composePromptFromState flattens state.values into the template context", () => {
		const state: State = {
			agentName: "Ada",
			values: { userName: "Bob" },
			data: {},
			text: "",
		};
		expect(
			composePromptFromState({
				state,
				template: "{{agentName}} meets {{userName}}",
			}),
		).toBe("Ada meets Bob");
	});
});

describe("parseKeyValueXml re-exported through the barrel", () => {
	it("parses a response block with entities and comma-separated actions", () => {
		const parsed = parseKeyValueXml(
			"<response><message>Hello &amp; bye</message><actions>send, reply</actions></response>",
		);
		expect(parsed).toEqual({
			message: "Hello & bye",
			actions: ["send", "reply"],
		});
	});

	it("fails closed on empty input", () => {
		expect(parseKeyValueXml("")).toBeNull();
	});

	it("rejects plain prose that contains no XML block", () => {
		expect(parseKeyValueXml("just words, nothing structured")).toBeNull();
	});
});

describe("view-kind helpers re-exported through the barrel", () => {
	it("resolveViewKind keeps explicit kinds over the legacy developerOnly flag", () => {
		expect(resolveViewKind({ viewKind: "system" })).toBe("system");
		expect(resolveViewKind({ developerOnly: true })).toBe("developer");
		expect(resolveViewKind(null)).toBe("release");
	});

	it("isViewVisible gates declarations end-to-end under the enabled set", () => {
		const off = { developer: false, preview: false };
		const devOn = { developer: true, preview: false };
		expect(isViewVisible({ developerOnly: true }, off)).toBe(false);
		expect(isViewVisible({ developerOnly: true }, devOn)).toBe(true);
		expect(isViewVisible(undefined, off)).toBe(true); // defaults to release
	});

	it("isAlwaysOnViewKind marks release always-on but preview toggleable", () => {
		expect(isAlwaysOnViewKind("release")).toBe(true);
		expect(isAlwaysOnViewKind("preview")).toBe(false);
	});
});

describe("surface-manifest helpers re-exported through the barrel", () => {
	it("resolves safe defaults for an absent declaration", () => {
		const resolved = resolveSurfaceManifest(null);
		expect(resolved.background).toBe("opaque");
		expect(resolved.header).toBe("normal");
		expect(resolved.isolation).toBe("in-process");
		expect(resolved.lifecycle).toBe("ephemeral");
		expect(surfaceGrants(resolved, "navigate")).toBe(false);
	});

	it("forces shared backgrounds opaque without the wallpaper grant", () => {
		expect(
			resolveSurfaceBackgroundPolicy({
				surface: { background: "shared" },
			}),
		).toBe("opaque");
		expect(
			resolveSurfaceBackgroundPolicy({
				surface: { background: "shared", capabilities: ["wallpaper"] },
			}),
		).toBe("shared");
	});

	it("falls back to legacy policy fields and lets the manifest win", () => {
		expect(resolveSurfaceManifest({ headerPolicy: "modal" }).header).toBe(
			"modal",
		);
		expect(
			resolveSurfaceManifest({
				surface: { header: "fullscreen" },
				headerPolicy: "modal",
			}).header,
		).toBe("fullscreen");
	});

	it("collapses duplicate capability grants", () => {
		const resolved = resolveSurfaceManifest({
			surface: { capabilities: ["storage", "storage"] },
		});
		expect(surfaceGrants(resolved, "storage")).toBe(true);
		expect(resolved.capabilities.size).toBe(1);
	});

	it("resolves the canonical immersive wallpaper surface to a painted manifest", () => {
		const resolved = resolveSurfaceManifest({
			surface: IMMERSIVE_WALLPAPER_SURFACE,
		});
		expect(resolved.background).toBe("shared");
		expect(resolved.isolation).toBe("immersive");
		expect(surfaceGrants(resolved, "wallpaper")).toBe(true);
		expect(surfaceGrants(resolved, "background:apply")).toBe(true);
		expect(surfaceGrants(resolved, "navigate")).toBe(false);
	});
});

describe("PENDING_USER_ACTION_WEIGHT re-exported through the barrel", () => {
	it("covers every documented pending-action kind with a finite weight", () => {
		const kinds = [
			"approval",
			"task_approval",
			"choice",
			"credential",
			"credential_request",
			"clarifying_question",
			"blocked_task",
			"prompt",
			"pending_prompt",
		] as const;
		for (const kind of kinds) {
			expect(Number.isFinite(PENDING_USER_ACTION_WEIGHT[kind])).toBe(true);
		}
	});

	it("ranks a hard block above a waiting prompt", () => {
		expect(PENDING_USER_ACTION_WEIGHT.blocked_task).toBeGreaterThan(
			PENDING_USER_ACTION_WEIGHT.prompt,
		);
	});

	it("groups approvals and choices into one severity class", () => {
		expect(PENDING_USER_ACTION_WEIGHT.approval).toBe(
			PENDING_USER_ACTION_WEIGHT.task_approval,
		);
		expect(PENDING_USER_ACTION_WEIGHT.approval).toBe(
			PENDING_USER_ACTION_WEIGHT.choice,
		);
	});
});
