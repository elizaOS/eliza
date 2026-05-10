/**
 * @module plugin-app-control/services/__tests__/app-registry-permissions
 *
 * Integration test for the slice 2 granted-permissions surface on
 * AppRegistryService — the store, getPermissionsView(),
 * setGrantedNamespaces() validation, and first-party auto-grant.
 *
 * Uses a per-test temp ELIZA_STATE_DIR so the registry, grants store,
 * and audit logs are real on-disk files we can read back.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AppRegistryEntry,
	AppRegistryService,
} from "../app-registry-service.js";

const NOOP_RUNTIME = {} as IAgentRuntime;

interface TempState {
	stateDir: string;
	previousStateDir: string | undefined;
	previousNamespace: string | undefined;
}

function makeTempState(): TempState {
	const stateDir = mkdtempSync(path.join(tmpdir(), "app-reg-perms-"));
	const previousStateDir = process.env.ELIZA_STATE_DIR;
	const previousNamespace = process.env.ELIZA_NAMESPACE;
	process.env.ELIZA_STATE_DIR = stateDir;
	delete process.env.ELIZA_NAMESPACE;
	return { stateDir, previousStateDir, previousNamespace };
}

function restoreTempState(state: TempState): void {
	rmSync(state.stateDir, { recursive: true, force: true });
	if (state.previousStateDir === undefined) {
		delete process.env.ELIZA_STATE_DIR;
	} else {
		process.env.ELIZA_STATE_DIR = state.previousStateDir;
	}
	if (state.previousNamespace === undefined) {
		delete process.env.ELIZA_NAMESPACE;
	} else {
		process.env.ELIZA_NAMESPACE = state.previousNamespace;
	}
}

function makeEntry(overrides: Partial<AppRegistryEntry>): AppRegistryEntry {
	return {
		slug: "demo",
		canonicalName: "@example/app-demo",
		aliases: [],
		directory: "/tmp/demo",
		displayName: "Demo",
		...overrides,
	};
}

function readAuditLines(stateDir: string, file: string): unknown[] {
	const auditPath = path.join(stateDir, "audit", file);
	const raw = (() => {
		try {
			return readFileSync(auditPath, "utf8");
		} catch {
			return "";
		}
	})();
	return raw
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line));
}

describe("AppRegistryService permissions surface", () => {
	let state: TempState;

	beforeEach(() => {
		state = makeTempState();
	});

	afterEach(() => {
		restoreTempState(state);
	});

	describe("getPermissionsView", () => {
		it("returns null for an unknown slug", async () => {
			const service = new AppRegistryService(NOOP_RUNTIME);
			const view = await service.getPermissionsView("does-not-exist");
			expect(view).toBeNull();
		});

		it("returns the recognised intersection of declared + recognised, with no grants by default for external apps", async () => {
			const service = new AppRegistryService(NOOP_RUNTIME);
			await service.register(
				makeEntry({
					requestedPermissions: {
						fs: { read: ["state/**"] },
						capabilities: { "screen-recording": true },
					},
				}),
				{ trust: "external" },
			);
			const view = await service.getPermissionsView("demo");
			expect(view).not.toBeNull();
			if (!view) return;
			expect(view.trust).toBe("external");
			expect(view.recognisedNamespaces).toEqual(["fs"]);
			expect(view.grantedNamespaces).toEqual([]);
			expect(view.grantedAt).toBeNull();
			expect(view.requestedPermissions).toEqual({
				fs: { read: ["state/**"] },
				capabilities: { "screen-recording": true },
			});
		});

		it("returns empty recognised list for an app with no permissions block", async () => {
			const service = new AppRegistryService(NOOP_RUNTIME);
			await service.register(makeEntry({}), { trust: "external" });
			const view = await service.getPermissionsView("demo");
			expect(view).not.toBeNull();
			if (!view) return;
			expect(view.recognisedNamespaces).toEqual([]);
			expect(view.grantedNamespaces).toEqual([]);
			expect(view.requestedPermissions).toBeNull();
		});
	});

	describe("setGrantedNamespaces", () => {
		it("rejects unknown slug", async () => {
			const service = new AppRegistryService(NOOP_RUNTIME);
			const result = await service.setGrantedNamespaces("nope", ["fs"], "user");
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.reason).toContain("No app registered");
		});

		it("rejects unknown namespace names", async () => {
			const service = new AppRegistryService(NOOP_RUNTIME);
			await service.register(
				makeEntry({ requestedPermissions: { fs: { read: ["state/**"] } } }),
				{ trust: "external" },
			);
			const result = await service.setGrantedNamespaces(
				"demo",
				["fs", "capabilities"],
				"user",
			);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.unknownNamespaces).toEqual(["capabilities"]);
		});

		it("rejects namespaces the app did not declare", async () => {
			const service = new AppRegistryService(NOOP_RUNTIME);
			await service.register(
				makeEntry({ requestedPermissions: { fs: { read: ["state/**"] } } }),
				{ trust: "external" },
			);
			const result = await service.setGrantedNamespaces(
				"demo",
				["fs", "net"],
				"user",
			);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.notRequestedNamespaces).toEqual(["net"]);
		});

		it("accepts a valid grant and surfaces it on the view", async () => {
			const service = new AppRegistryService(NOOP_RUNTIME);
			await service.register(
				makeEntry({
					requestedPermissions: {
						fs: { read: ["state/**"] },
						net: { outbound: ["api.foo.com"] },
					},
				}),
				{ trust: "external" },
			);
			const result = await service.setGrantedNamespaces("demo", ["fs"], "user");
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.view.grantedNamespaces).toEqual(["fs"]);
			expect(result.view.grantedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

			const view = await service.getPermissionsView("demo");
			expect(view?.grantedNamespaces).toEqual(["fs"]);
		});

		it("is idempotent — setting the same set twice produces no extra audit lines", async () => {
			const service = new AppRegistryService(NOOP_RUNTIME);
			await service.register(
				makeEntry({ requestedPermissions: { fs: { read: ["**"] } } }),
				{ trust: "external" },
			);
			await service.setGrantedNamespaces("demo", ["fs"], "user");
			await service.setGrantedNamespaces("demo", ["fs"], "user");
			const lines = readAuditLines(state.stateDir, "app-permissions.jsonl");
			expect(lines.length).toBe(1);
			expect(lines[0]).toMatchObject({
				kind: "granted",
				namespaces: ["fs"],
				actor: "user",
			});
		});

		it("revoking a previously-granted namespace appends a 'revoked' audit line", async () => {
			const service = new AppRegistryService(NOOP_RUNTIME);
			await service.register(
				makeEntry({
					requestedPermissions: {
						fs: { read: ["**"] },
						net: { outbound: ["*"] },
					},
				}),
				{ trust: "external" },
			);
			await service.setGrantedNamespaces("demo", ["fs", "net"], "user");
			await service.setGrantedNamespaces("demo", ["fs"], "user");
			const lines = readAuditLines(state.stateDir, "app-permissions.jsonl");
			expect(lines).toHaveLength(2);
			expect(lines[0]).toMatchObject({
				kind: "granted",
				namespaces: ["fs", "net"],
			});
			expect(lines[1]).toMatchObject({
				kind: "revoked",
				namespaces: ["net"],
			});
		});

		it("setting an empty set fully revokes and removes the entry from the store", async () => {
			const service = new AppRegistryService(NOOP_RUNTIME);
			await service.register(
				makeEntry({ requestedPermissions: { fs: { read: ["**"] } } }),
				{ trust: "external" },
			);
			await service.setGrantedNamespaces("demo", ["fs"], "user");
			await service.setGrantedNamespaces("demo", [], "user");
			const view = await service.getPermissionsView("demo");
			expect(view?.grantedNamespaces).toEqual([]);
			expect(view?.grantedAt).toBeNull();
		});
	});

	describe("first-party auto-grant on register", () => {
		it("auto-grants all declared recognised namespaces", async () => {
			const service = new AppRegistryService(NOOP_RUNTIME);
			await service.register(
				makeEntry({
					requestedPermissions: {
						fs: { read: ["**"] },
						net: { outbound: ["*"] },
					},
				}),
				{ trust: "first-party" },
			);
			const view = await service.getPermissionsView("demo");
			expect(view?.grantedNamespaces.sort()).toEqual(["fs", "net"]);
			const lines = readAuditLines(state.stateDir, "app-permissions.jsonl");
			expect(lines).toHaveLength(1);
			expect(lines[0]).toMatchObject({
				kind: "granted",
				namespaces: ["fs", "net"],
				actor: "first-party-auto",
			});
		});

		it("does not auto-grant for first-party apps with no permissions block", async () => {
			const service = new AppRegistryService(NOOP_RUNTIME);
			await service.register(makeEntry({}), { trust: "first-party" });
			const lines = readAuditLines(state.stateDir, "app-permissions.jsonl");
			expect(lines).toHaveLength(0);
		});

		it("external register does not auto-grant", async () => {
			const service = new AppRegistryService(NOOP_RUNTIME);
			await service.register(
				makeEntry({ requestedPermissions: { fs: { read: ["**"] } } }),
				{ trust: "external" },
			);
			const view = await service.getPermissionsView("demo");
			expect(view?.grantedNamespaces).toEqual([]);
			const lines = readAuditLines(state.stateDir, "app-permissions.jsonl");
			expect(lines).toHaveLength(0);
		});
	});

	describe("isolation persistence (Phase 2.1)", () => {
		it("defaults isolation to 'none' when entry omits it", async () => {
			const service = new AppRegistryService(NOOP_RUNTIME);
			await service.register(makeEntry({}), { trust: "external" });
			const view = await service.getPermissionsView("demo");
			expect(view?.isolation).toBe("none");
		});

		it("persists isolation:'worker' across service restart", async () => {
			const first = new AppRegistryService(NOOP_RUNTIME);
			await first.register(
				makeEntry({
					isolation: "worker",
					requestedPermissions: { fs: { read: ["**"] } },
				}),
				{ trust: "external" },
			);
			const sameProcess = await first.getPermissionsView("demo");
			expect(sameProcess?.isolation).toBe("worker");

			const fresh = new AppRegistryService(NOOP_RUNTIME);
			const afterRestart = await fresh.getPermissionsView("demo");
			expect(afterRestart?.isolation).toBe("worker");
		});

		it("defaults missing isolation to 'none' for back-compat with pre-Phase-2 entries", async () => {
			const fs = await import("node:fs/promises");
			const registryPath = path.join(state.stateDir, "app-registry.json");
			await fs.writeFile(
				registryPath,
				JSON.stringify({
					version: 1,
					entries: [
						{
							slug: "legacy",
							canonicalName: "@example/app-legacy",
							aliases: [],
							directory: "/tmp/legacy",
							displayName: "Legacy",
							// No isolation field
						},
					],
				}),
			);
			const service = new AppRegistryService(NOOP_RUNTIME);
			const view = await service.getPermissionsView("legacy");
			expect(view?.isolation).toBe("none");
		});
	});

	describe("trust persistence (regression: PR #7554 review P1)", () => {
		it("stores trust on the entry so first-party labels survive a restart", async () => {
			const first = new AppRegistryService(NOOP_RUNTIME);
			await first.register(
				makeEntry({
					requestedPermissions: { fs: { read: ["**"] } },
				}),
				{ trust: "first-party" },
			);
			const viewSameProcess = await first.getPermissionsView("demo");
			expect(viewSameProcess?.trust).toBe("first-party");

			const second = new AppRegistryService(NOOP_RUNTIME);
			const viewAfterRestart = await second.getPermissionsView("demo");
			expect(viewAfterRestart?.trust).toBe("first-party");
		});

		it("defaults missing trust to 'external' for back-compat with pre-fix entries", async () => {
			// Simulate an older registry file (pre-fix shape: no trust field).
			const fs = await import("node:fs/promises");
			const registryPath = path.join(state.stateDir, "app-registry.json");
			await fs.writeFile(
				registryPath,
				JSON.stringify({
					version: 1,
					entries: [
						{
							slug: "legacy",
							canonicalName: "@example/app-legacy",
							aliases: [],
							directory: "/tmp/legacy",
							displayName: "Legacy",
						},
					],
				}),
			);

			const service = new AppRegistryService(NOOP_RUNTIME);
			const view = await service.getPermissionsView("legacy");
			expect(view?.trust).toBe("external");
		});

		it("listPermissionsViews returns the right trust per app", async () => {
			const service = new AppRegistryService(NOOP_RUNTIME);
			await service.register(
				makeEntry({
					slug: "first",
					canonicalName: "@example/app-first",
					requestedPermissions: { fs: { read: ["**"] } },
				}),
				{ trust: "first-party" },
			);
			await service.register(
				makeEntry({
					slug: "ext",
					canonicalName: "@example/app-ext",
					requestedPermissions: { net: { outbound: ["*"] } },
				}),
				{ trust: "external" },
			);
			const views = await service.listPermissionsViews();
			const trustBySlug = Object.fromEntries(
				views.map((v) => [v.slug, v.trust]),
			);
			expect(trustBySlug).toEqual({
				first: "first-party",
				ext: "external",
			});
		});
	});

	describe("persistence round-trip", () => {
		it("survives service restart", async () => {
			const first = new AppRegistryService(NOOP_RUNTIME);
			await first.register(
				makeEntry({
					requestedPermissions: {
						fs: { read: ["state/**"] },
						net: { outbound: ["api.foo.com"] },
					},
				}),
				{ trust: "external" },
			);
			await first.setGrantedNamespaces("demo", ["fs"], "user");

			const second = new AppRegistryService(NOOP_RUNTIME);
			const view = await second.getPermissionsView("demo");
			expect(view?.grantedNamespaces).toEqual(["fs"]);
			expect(view?.recognisedNamespaces).toEqual(["fs", "net"]);
		});

		it("filters out unrecognised namespaces in the persisted file", async () => {
			const service = new AppRegistryService(NOOP_RUNTIME);
			await service.register(
				makeEntry({ requestedPermissions: { fs: { read: ["**"] } } }),
				{ trust: "external" },
			);
			await service.setGrantedNamespaces("demo", ["fs"], "user");

			// Tamper with the on-disk file to simulate a future-Milady writeback
			// containing a namespace this version doesn't recognise.
			const grantsPath = path.join(state.stateDir, "granted-permissions.json");
			const raw = readFileSync(grantsPath, "utf8");
			const parsed = JSON.parse(raw);
			parsed.grants.demo.namespaces.push("capabilities");
			const fs = await import("node:fs/promises");
			await fs.writeFile(grantsPath, JSON.stringify(parsed));

			const fresh = new AppRegistryService(NOOP_RUNTIME);
			const view = await fresh.getPermissionsView("demo");
			expect(view?.grantedNamespaces).toEqual(["fs"]);
		});
	});
});
