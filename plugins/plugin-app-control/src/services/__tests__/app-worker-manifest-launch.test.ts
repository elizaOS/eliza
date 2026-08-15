/**
 * Integration-backed manifest-to-launch coverage for app worker capability
 * declarations. Each case is discovered through the real directory loader and
 * then handed to the real worker host; only registry persistence is replaced
 * by a deterministic in-memory seam.
 */

import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { runLoadFromDirectory } from "../../actions/app-load-from-directory.js";
import {
	APP_REGISTRY_SERVICE_TYPE,
	type AppRegistryEntry,
} from "../app-registry-service.js";
import { AppWorkerHostService } from "../app-worker-host-service.js";

const sourceFixture = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../test/fixtures/sandbox-plugin/plugin.ts",
);
const roots: string[] = [];
const hosts: AppWorkerHostService[] = [];

afterEach(async () => {
	await Promise.all(hosts.splice(0).map((host) => host.stop()));
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

async function loadManifestAndCreateHost(options: {
	slug: string;
	worker?: false | { entry: string };
	writeEntry?: string;
}): Promise<{ entry: AppRegistryEntry; host: AppWorkerHostService }> {
	const root = mkdtempSync(path.join(tmpdir(), "app-worker-manifest-"));
	roots.push(root);
	const appDirectory = path.join(root, options.slug);
	mkdirSync(appDirectory, { recursive: true });
	writeFileSync(
		path.join(appDirectory, "package.json"),
		JSON.stringify({
			name: `@fixture/${options.slug}`,
			type: "module",
			elizaos: {
				app: {
					slug: options.slug,
					displayName: options.slug,
					isolation: "worker",
					...(options.worker !== undefined ? { worker: options.worker } : {}),
				},
			},
		}),
	);
	if (options.writeEntry) {
		const target = path.join(appDirectory, options.writeEntry);
		mkdirSync(path.dirname(target), { recursive: true });
		copyFileSync(sourceFixture, target);
	}

	let registered: AppRegistryEntry | undefined;
	const registry = {
		register: async (entry: AppRegistryEntry) => {
			registered = entry;
		},
		recordManifestRejection: async () => {},
		list: async () => (registered ? [registered] : []),
		getPermissionsView: async () => null,
	};
	const runtime = {
		agentId: "00000000-0000-0000-0000-000000000001",
		getService: (type: string) =>
			type === APP_REGISTRY_SERVICE_TYPE ? registry : null,
	} as unknown as IAgentRuntime;
	const result = await runLoadFromDirectory({
		runtime,
		message: {
			entityId: "00000000-0000-0000-0000-000000000002",
			roomId: "00000000-0000-0000-0000-000000000003",
			content: { text: "load fixtures" },
		} as Memory,
		options: { directory: root },
		repoRoot: root,
	});
	if (!result.success || !registered) {
		throw new Error(`Fixture manifest was not registered: ${result.text}`);
	}
	const host = new AppWorkerHostService(runtime);
	hosts.push(host);
	return { entry: registered, host };
}

describe("app worker manifest launch contract", () => {
	it("keeps an explicitly static app out of the worker host", async () => {
		const { entry, host } = await loadManifestAndCreateHost({
			slug: "explicit-static",
			worker: false,
			writeEntry: "src/index.ts",
		});
		expect(entry.worker).toBe(false);
		expect(await host.startForRegisteredApp(entry.slug)).toMatchObject({
			ok: false,
			kind: "no-worker-surface",
		});
	});

	it("launches a declared worker plugin from its explicit entry", async () => {
		const { entry, host } = await loadManifestAndCreateHost({
			slug: "declared-worker",
			worker: { entry: "worker/plugin.ts" },
			writeEntry: "worker/plugin.ts",
		});
		expect(entry.worker).toEqual({ entry: "worker/plugin.ts" });
		const launch = await host.startForRegisteredApp(entry.slug);
		expect(launch.ok).toBe(true);
		const ping = await host.invoke<{ actions: string[] }>(entry.slug, "ping");
		expect(ping.ok).toBe(true);
		if (ping.ok) expect(ping.result.actions).toContain("ECHO");
	});

	it("reports a missing declared worker artifact as a broken launch", async () => {
		const { entry, host } = await loadManifestAndCreateHost({
			slug: "unbuilt-worker",
			worker: { entry: "dist/plugin.js" },
		});
		expect(await host.startForRegisteredApp(entry.slug)).toMatchObject({
			ok: false,
			kind: "error",
			reason: expect.stringContaining("build or repair"),
		});
	});

	it("uses conventional source discovery only for a legacy manifest", async () => {
		const { entry, host } = await loadManifestAndCreateHost({
			slug: "legacy-worker",
			writeEntry: "src/index.ts",
		});
		expect(entry.worker).toBeUndefined();
		const launch = await host.startForRegisteredApp(entry.slug);
		expect(launch.ok).toBe(true);
		const ping = await host.invoke<{ actions: string[] }>(entry.slug, "ping");
		expect(ping.ok).toBe(true);
		if (ping.ok) expect(ping.result.actions).toContain("ECHO");
	});
});
