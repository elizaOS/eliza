/**
 * @module plugin-app-control/actions/__tests__/app-load-from-directory.test
 *
 * load_from_directory sub-mode: scaffolds a tempdir with a mix of valid
 * Eliza apps (package.json with elizaos.app field) and decoys (no manifest
 * / wrong shape), then verifies the handler:
 *
 *   - rejects non-absolute paths up front (no service touched)
 *   - returns success:false when no AppRegistryService is registered
 *     (no throw — runtime stays alive)
 *   - skips subdirs without a valid elizaos.app manifest
 *   - calls AppRegistryService.register exactly once per discovered app
 *     with the requester's entityId / roomId in context
 *   - reports the registered count + entries in the structured result
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HandlerCallback, IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	APP_REGISTRY_SERVICE_TYPE,
	type AppRegistryEntry,
} from "../../services/app-registry-service.js";
import { runLoadFromDirectory } from "../app-load-from-directory.js";

let scanRoot: string;

beforeEach(async () => {
	scanRoot = await mkdtemp(path.join(tmpdir(), "milady-app-load-dir-"));
});

afterEach(async () => {
	await rm(scanRoot, { recursive: true, force: true });
});

async function writeAppManifest(
	dir: string,
	pkg: Record<string, unknown>,
): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg), "utf8");
}

function makeMessage(text = "load apps from disk"): Memory {
	return {
		entityId: "owner-42",
		roomId: "room-abc",
		content: { text },
	} as unknown as Memory;
}

function callbackBag() {
	const messages: string[] = [];
	const cb: HandlerCallback = async (msg) => {
		messages.push(typeof msg.text === "string" ? msg.text : "");
		return [];
	};
	return { cb, messages };
}

describe("APP load_from_directory", () => {
	it("rejects a non-absolute path without touching the registry", async () => {
		const register = vi.fn();
		const runtime = {
			getService: vi.fn(() => ({ register })),
		} as unknown as IAgentRuntime;
		const bag = callbackBag();

		const result = await runLoadFromDirectory({
			runtime,
			message: makeMessage(),
			options: { directory: "relative/path" },
			callback: bag.cb,
		});

		expect(result.success).toBe(false);
		expect(result.text).toContain("absolute path");
		expect(register).not.toHaveBeenCalled();
	});

	it("returns success:false when no AppRegistryService is registered (no throw)", async () => {
		const runtime = {
			getService: vi.fn(() => null),
		} as unknown as IAgentRuntime;
		const bag = callbackBag();

		await writeAppManifest(path.join(scanRoot, "app-foo"), {
			name: "@me/app-foo",
			elizaos: {
				app: { displayName: "Foo", category: "utility" },
			},
		});

		let threw = false;
		let result;
		try {
			result = await runLoadFromDirectory({
				runtime,
				message: makeMessage(),
				options: { directory: scanRoot },
				callback: bag.cb,
			});
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(result?.success).toBe(false);
		expect(result?.text).toContain("AppRegistryService");
	});

	it("scans subdirs, skips decoys, registers each valid app exactly once", async () => {
		// Valid: has elizaos.app
		await writeAppManifest(path.join(scanRoot, "app-foo"), {
			name: "@me/app-foo",
			elizaos: {
				app: {
					displayName: "Foo",
					category: "utility",
					aliases: ["foo", "fooz"],
				},
			},
		});
		// Valid: explicit slug
		await writeAppManifest(path.join(scanRoot, "app-bar"), {
			name: "@me/app-bar",
			elizaos: {
				app: { displayName: "Bar", slug: "bar-app" },
			},
		});
		// Decoy: package.json but no elizaos.app
		await writeAppManifest(path.join(scanRoot, "tool-noop"), {
			name: "@me/tool-noop",
		});
		// Decoy: dir without package.json
		await mkdir(path.join(scanRoot, "scratch"), { recursive: true });
		// Decoy: file at top level
		await writeFile(path.join(scanRoot, "README"), "noise", "utf8");

		const register = vi.fn<
			(entry: AppRegistryEntry, ctx?: Record<string, unknown>) => Promise<void>
		>(async () => {});
		const runtime = {
			getService: vi.fn((type: string) => {
				if (type === APP_REGISTRY_SERVICE_TYPE) return { register };
				return null;
			}),
		} as unknown as IAgentRuntime;
		const bag = callbackBag();

		const result = await runLoadFromDirectory({
			runtime,
			message: makeMessage(),
			options: { directory: scanRoot },
			callback: bag.cb,
		});

		expect(result.success).toBe(true);
		expect(result.values).toMatchObject({
			mode: "load_from_directory",
			directory: scanRoot,
			registeredCount: 2,
		});

		// Two apps registered, decoys skipped.
		expect(register).toHaveBeenCalledTimes(2);

		const calls = register.mock.calls.map((c) => c[0]);
		const slugs = calls.map((e) => e.slug).sort();
		expect(slugs).toEqual(["bar-app", "foo"]);

		const foo = calls.find((e) => e.slug === "foo");
		expect(foo).toMatchObject({
			canonicalName: "@me/app-foo",
			displayName: "Foo",
			aliases: ["foo", "fooz"],
		});
		expect(foo?.directory.endsWith("app-foo")).toBe(true);

		const bar = calls.find((e) => e.slug === "bar-app");
		expect(bar).toMatchObject({
			canonicalName: "@me/app-bar",
			displayName: "Bar",
			aliases: [],
		});
		expect(bar?.directory.endsWith("app-bar")).toBe(true);

		// Each register call carries the requester context for the audit log.
		register.mock.calls.forEach((call) => {
			const ctx = call[1] as Record<string, unknown> | undefined;
			expect(ctx).toMatchObject({
				requesterEntityId: "owner-42",
				requesterRoomId: "room-abc",
			});
		});

		// Callback message lists what was registered and explicitly notes
		// that nothing was launched.
		const out = bag.messages.join("\n");
		expect(out).toContain("Registered 2 apps");
		expect(out).toContain("Foo");
		expect(out).toContain("Bar");
		expect(out).toContain("registered only");
	});

	it("returns success with empty list when directory contains no apps", async () => {
		const register = vi.fn();
		const runtime = {
			getService: vi.fn(() => ({ register })),
		} as unknown as IAgentRuntime;
		const bag = callbackBag();

		// Empty dir.
		const result = await runLoadFromDirectory({
			runtime,
			message: makeMessage(),
			options: { directory: scanRoot },
			callback: bag.cb,
		});

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({
			directory: scanRoot,
			registered: [],
		});
		expect(register).not.toHaveBeenCalled();
	});
});
