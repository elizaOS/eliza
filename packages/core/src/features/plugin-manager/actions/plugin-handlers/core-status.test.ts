/**
 * Exercises the core-status action handler's planner-facing output for packaged,
 * ejected, unavailable, and incomplete upstream states using the real handler.
 */

import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import type {
	CoreStatus,
	UpstreamMetadata,
} from "../../services/coreManagerService.ts";
import { runCoreStatus } from "./core-status.ts";

const BASE_STATUS: CoreStatus = {
	ejected: false,
	ejectedPath: "/state/core",
	monorepoPath: "/state/core/eliza",
	corePackagePath: "/state/core/eliza/packages/core",
	coreDistPath: "/state/core/eliza/packages/core/dist",
	version: "2.0.0",
	npmVersion: "2.0.3-beta.7",
	commitHash: null,
	localChanges: false,
	upstream: null,
};

const UPSTREAM: UpstreamMetadata = {
	$schema: "eliza-upstream-v1",
	source: "github:elizaos/eliza",
	gitUrl: "https://github.com/elizaOS/eliza.git",
	branch: "develop",
	commitHash: "upstream-commit",
	ejectedAt: "2026-08-20T10:00:00.000Z",
	npmPackage: "@elizaos/core",
	npmVersion: "2.0.3-beta.7",
	lastSyncAt: "2026-08-22T12:30:00.000Z",
	localCommits: 2,
};

function createRuntime(status: CoreStatus | null): {
	runtime: IAgentRuntime;
	serviceNames: string[];
	statusReads: () => number;
} {
	const serviceNames: string[] = [];
	let reads = 0;
	const service =
		status === null
			? null
			: {
					getCoreStatus: async () => {
						reads += 1;
						return status;
					},
				};

	return {
		runtime: {
			getService: (name: string) => {
				serviceNames.push(name);
				return service;
			},
		} as unknown as IAgentRuntime,
		serviceNames,
		statusReads: () => reads,
	};
}

describe("runCoreStatus", () => {
	it("returns a structured failure when the core manager is unavailable", async () => {
		const { runtime, serviceNames, statusReads } = createRuntime(null);
		let callbackCalls = 0;

		const result = await runCoreStatus({
			runtime,
			callback: async () => {
				callbackCalls += 1;
				return [];
			},
		});

		expect(result).toEqual({
			success: false,
			text: "Core manager service not available",
		});
		expect(serviceNames).toEqual(["core_manager"]);
		expect(statusReads()).toBe(0);
		expect(callbackCalls).toBe(0);
	});

	it("reports the packaged npm version and complete status data", async () => {
		const { runtime, statusReads } = createRuntime(BASE_STATUS);

		const result = await runCoreStatus({ runtime });

		expect(result).toEqual({
			success: true,
			text: "Core is using NPM package (v2.0.3-beta.7). Not ejected.",
			values: { mode: "core_status", ejected: false },
			data: {
				ejected: false,
				ejectedPath: "/state/core",
				monorepoPath: "/state/core/eliza",
				corePackagePath: "/state/core/eliza/packages/core",
				coreDistPath: "/state/core/eliza/packages/core/dist",
				version: "2.0.0",
				npmVersion: "2.0.3-beta.7",
				commitHash: undefined,
				localChanges: false,
				upstream: undefined,
			},
		});
		expect(statusReads()).toBe(1);
	});

	it("renders ejected status fields and upstream metadata in order", async () => {
		const status: CoreStatus = {
			...BASE_STATUS,
			ejected: true,
			version: "2.1.0-local",
			commitHash: "abc1234",
			localChanges: true,
			upstream: UPSTREAM,
		};
		const { runtime } = createRuntime(status);

		const result = await runCoreStatus({ runtime });

		expect(result.text).toBe(
			[
				"Core is EJECTED at /state/core",
				"Version: 2.1.0-local",
				"Commit: abc1234",
				"Local changes: yes",
				"Upstream: https://github.com/elizaOS/eliza.git#develop",
				"Last sync: 2026-08-22T12:30:00.000Z",
			].join("\n"),
		);
		expect(result.values).toEqual({ mode: "core_status", ejected: true });
		expect(result.data).toMatchObject({
			commitHash: "abc1234",
			localChanges: true,
			upstream: UPSTREAM,
		});
	});

	it("uses fallback labels for a missing commit and never-synced upstream", async () => {
		const neverSyncedUpstream: UpstreamMetadata = {
			...UPSTREAM,
			lastSyncAt: null,
		};
		const status: CoreStatus = {
			...BASE_STATUS,
			ejected: true,
			commitHash: null,
			upstream: neverSyncedUpstream,
		};
		const { runtime } = createRuntime(status);

		const result = await runCoreStatus({ runtime });

		expect(result.text).toContain("Commit: unknown");
		expect(result.text).toContain("Local changes: no");
		expect(result.text).toContain("Last sync: never");
		expect(result.data?.commitHash).toBeUndefined();
		expect(result.data?.upstream).toEqual(neverSyncedUpstream);
	});

	it("omits upstream lines when an ejected core has no upstream metadata", async () => {
		const status: CoreStatus = {
			...BASE_STATUS,
			ejected: true,
			commitHash: "detached-head",
		};
		const { runtime } = createRuntime(status);

		const result = await runCoreStatus({ runtime });

		expect(result.text).toBe(
			[
				"Core is EJECTED at /state/core",
				"Version: 2.0.0",
				"Commit: detached-head",
				"Local changes: no",
			].join("\n"),
		);
		expect(result.text).not.toContain("Upstream:");
		expect(result.text).not.toContain("Last sync:");
		expect(result.data?.upstream).toBeUndefined();
	});
});
