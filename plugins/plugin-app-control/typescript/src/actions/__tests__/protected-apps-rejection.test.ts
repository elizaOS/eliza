/**
 * @module plugin-app-control/actions/__tests__/protected-apps-rejection.test
 *
 * Integration test for the protected-apps gate inside the
 * `APP load_from_directory` flow:
 *
 *   - When `MILADY_PROTECTED_APPS` lists a name, a discovered app whose
 *     package.json declares that name is NOT registered.
 *   - When the repo's `eliza/apps/<name>/` exists, a discovered app
 *     colliding on the basename or suffix is NOT registered.
 *   - Non-protected apps in the same scan still register exactly once.
 *   - The action result + callback message surface the rejection.
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
let repoRoot: string;
let originalProtectedEnv: string | undefined;

beforeEach(async () => {
	scanRoot = await mkdtemp(path.join(tmpdir(), "milady-app-protect-scan-"));
	repoRoot = await mkdtemp(path.join(tmpdir(), "milady-app-protect-repo-"));
	originalProtectedEnv = process.env.MILADY_PROTECTED_APPS;
	delete process.env.MILADY_PROTECTED_APPS;
});

afterEach(async () => {
	if (originalProtectedEnv === undefined) {
		delete process.env.MILADY_PROTECTED_APPS;
	} else {
		process.env.MILADY_PROTECTED_APPS = originalProtectedEnv;
	}
	await rm(scanRoot, { recursive: true, force: true });
	await rm(repoRoot, { recursive: true, force: true });
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

interface RegistrySpy {
	register: ReturnType<
		typeof vi.fn<
			(entry: AppRegistryEntry, ctx?: Record<string, unknown>) => Promise<void>
		>
	>;
	runtime: IAgentRuntime;
}

function makeRegistry(): RegistrySpy {
	const register = vi.fn<
		(entry: AppRegistryEntry, ctx?: Record<string, unknown>) => Promise<void>
	>(async () => {});
	const runtime = {
		getService: vi.fn((type: string) => {
			if (type === APP_REGISTRY_SERVICE_TYPE) return { register };
			return null;
		}),
	} as unknown as IAgentRuntime;
	return { register, runtime };
}

describe("APP load_from_directory — protected-apps gate", () => {
	it("rejects an app whose package name is listed in MILADY_PROTECTED_APPS and registers the rest", async () => {
		process.env.MILADY_PROTECTED_APPS = "@elizaos/app-companion,custom-locked";

		// Protected by exact env match (scoped name).
		await writeAppManifest(path.join(scanRoot, "app-companion"), {
			name: "@elizaos/app-companion",
			elizaos: {
				app: { displayName: "Companion (clobber attempt)" },
			},
		});
		// Protected by env match on the bare slug `custom-locked`.
		await writeAppManifest(path.join(scanRoot, "custom-locked"), {
			name: "@me/custom-locked",
			elizaos: {
				app: { displayName: "Custom Locked Clobber", slug: "custom-locked" },
			},
		});
		// Not protected — should register.
		await writeAppManifest(path.join(scanRoot, "app-foo"), {
			name: "@me/app-foo",
			elizaos: {
				app: { displayName: "Foo" },
			},
		});

		const { register, runtime } = makeRegistry();
		const bag = callbackBag();

		const result = await runLoadFromDirectory({
			runtime,
			message: makeMessage(),
			options: { directory: scanRoot },
			callback: bag.cb,
			repoRoot,
		});

		expect(result.success).toBe(true);
		expect(register).toHaveBeenCalledTimes(1);
		const entry = register.mock.calls[0]?.[0];
		expect(entry?.canonicalName).toBe("@me/app-foo");

		expect(result.values).toMatchObject({
			mode: "load_from_directory",
			registeredCount: 1,
			rejectedCount: 2,
		});

		const rejectedNames = (
			result.data as { rejected?: Array<{ packageName: string }> }
		).rejected?.map((r) => r.packageName);
		expect(rejectedNames?.sort()).toEqual([
			"@elizaos/app-companion",
			"@me/custom-locked",
		]);

		const out = bag.messages.join("\n");
		expect(out).toContain("Skipped 2 protected apps");
		expect(out).toContain("@elizaos/app-companion");
		expect(out).toContain("@me/custom-locked");
		expect(out).toContain("cannot override first-party apps");
	});

	it("rejects apps that collide with first-party `eliza/apps/<name>/` even when env is unset", async () => {
		// Synthetic first-party app under repoRoot's eliza/apps/.
		await mkdir(path.join(repoRoot, "eliza", "apps", "app-companion"), {
			recursive: true,
		});

		// Foreign-scoped clone tries to clobber the first-party slug.
		await writeAppManifest(path.join(scanRoot, "app-companion"), {
			name: "@evil/app-companion",
			elizaos: {
				app: { displayName: "Evil Companion" },
			},
		});
		// A safe app passes through.
		await writeAppManifest(path.join(scanRoot, "app-foo"), {
			name: "@me/app-foo",
			elizaos: {
				app: { displayName: "Foo" },
			},
		});

		const { register, runtime } = makeRegistry();
		const bag = callbackBag();

		const result = await runLoadFromDirectory({
			runtime,
			message: makeMessage(),
			options: { directory: scanRoot },
			callback: bag.cb,
			repoRoot,
		});

		expect(result.success).toBe(true);
		expect(register).toHaveBeenCalledTimes(1);
		expect(register.mock.calls[0]?.[0]?.canonicalName).toBe("@me/app-foo");

		expect(result.values).toMatchObject({
			registeredCount: 1,
			rejectedCount: 1,
		});

		const out = bag.messages.join("\n");
		expect(out).toContain("Skipped 1 protected app");
		expect(out).toContain("@evil/app-companion");
	});

	it("rejects on alias collision with the protected set", async () => {
		process.env.MILADY_PROTECTED_APPS = "companion";

		await writeAppManifest(path.join(scanRoot, "app-foo"), {
			name: "@me/app-foo",
			elizaos: {
				// `aliases: ["companion"]` collides with env entry `companion`.
				app: { displayName: "Foo", aliases: ["companion", "foo"] },
			},
		});

		const { register, runtime } = makeRegistry();
		const bag = callbackBag();

		const result = await runLoadFromDirectory({
			runtime,
			message: makeMessage(),
			options: { directory: scanRoot },
			callback: bag.cb,
			repoRoot,
		});

		expect(result.success).toBe(true);
		expect(register).not.toHaveBeenCalled();
		expect(result.values).toMatchObject({
			registeredCount: 0,
			rejectedCount: 1,
		});
	});
});
