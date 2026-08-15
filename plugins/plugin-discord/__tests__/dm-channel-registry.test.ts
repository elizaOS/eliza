/**
 * Covers the DM channel registry and the cold-start re-open path (#18746):
 * bounded LRU persistence with no message content, corrupt/missing files
 * degrading to empty with a warning, and reopenPersistedDms counting failures
 * without throwing while preferring cached channels over REST calls.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DmChannelRegistry } from "../dm-channel-registry.ts";
import { reopenPersistedDms } from "../startup-reaction-reconcile.ts";

const dirs: string[] = [];
function tempFile(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "dm-registry-"));
	dirs.push(dir);
	return path.join(dir, "dm-channels-test.json");
}
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function makeLogger() {
	return { warn: vi.fn() };
}

describe("DmChannelRegistry", () => {
	it("persists records and reloads them newest-first", () => {
		const file = tempFile();
		let clock = 1000;
		const first = new DmChannelRegistry({
			filePath: file,
			logger: makeLogger(),
			now: () => clock++,
		});
		first.record("chan-a", "user-a");
		first.record("chan-b", "user-b");

		const second = new DmChannelRegistry({
			filePath: file,
			logger: makeLogger(),
		});
		const recent = second.listRecent();
		expect(recent.map((r) => r.channelId)).toEqual(["chan-b", "chan-a"]);
		expect(recent[0].recipientId).toBe("user-b");
	});

	it("stores only ids and timestamps, never content", () => {
		const file = tempFile();
		const registry = new DmChannelRegistry({
			filePath: file,
			logger: makeLogger(),
		});
		registry.record("chan-a", "user-a");
		const raw = JSON.parse(readFileSync(file, "utf8"));
		expect(Object.keys(raw.entries[0]).sort()).toEqual([
			"channelId",
			"lastSeenAt",
			"recipientId",
		]);
	});

	it("evicts the oldest entry beyond the cap, newest observation wins", () => {
		const file = tempFile();
		let clock = 0;
		const registry = new DmChannelRegistry({
			filePath: file,
			logger: makeLogger(),
			now: () => clock++,
			maxEntries: 2,
		});
		registry.record("chan-a", "user-a");
		registry.record("chan-b", "user-b");
		registry.record("chan-a", "user-a"); // refresh a: b is now oldest
		registry.record("chan-c", "user-c");
		expect(
			registry
				.listRecent()
				.map((r) => r.channelId)
				.sort(),
		).toEqual(["chan-a", "chan-c"]);
	});

	it("degrades a corrupt file to empty with a warning, then recovers", () => {
		const file = tempFile();
		writeFileSync(file, "{not json", "utf8");
		const logger = makeLogger();
		const registry = new DmChannelRegistry({ filePath: file, logger });
		expect(registry.listRecent()).toEqual([]);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		registry.record("chan-a", "user-a");
		expect(registry.listRecent()).toHaveLength(1);
	});

	it("treats a missing file as the cold state, no warning", () => {
		const logger = makeLogger();
		const registry = new DmChannelRegistry({ filePath: tempFile(), logger });
		expect(registry.listRecent()).toEqual([]);
		expect(logger.warn).not.toHaveBeenCalled();
	});
});

describe("reopenPersistedDms", () => {
	function makeClient(
		cached: Record<string, unknown>,
		createDM: ReturnType<typeof vi.fn>,
	) {
		return {
			channels: { cache: new Map(Object.entries(cached)) },
			users: { createDM },
		} as never;
	}

	it("prefers cached channels and re-opens only the missing ones", async () => {
		const cachedChannel = { id: "chan-a" };
		const reopened = { id: "chan-b" };
		const createDM = vi.fn(async () => reopened);
		const result = await reopenPersistedDms({
			client: makeClient({ "chan-a": cachedChannel }, createDM),
			records: [
				{ channelId: "chan-a", recipientId: "user-a" },
				{ channelId: "chan-b", recipientId: "user-b" },
			],
			logger: { info: vi.fn(), warn: vi.fn() },
		});
		expect(createDM).toHaveBeenCalledTimes(1);
		expect(createDM).toHaveBeenCalledWith("user-b");
		expect(result.channels).toEqual([cachedChannel, reopened]);
		expect(result.failures).toBe(0);
	});

	it("counts and logs re-open failures without throwing, and honors the limit", async () => {
		const createDM = vi.fn(async (id: string) => {
			if (id === "user-a") throw new Error("Cannot send messages to this user");
			return { id: `dm-${id}` };
		});
		const warn = vi.fn();
		const result = await reopenPersistedDms({
			client: makeClient({}, createDM),
			records: [
				{ channelId: "chan-a", recipientId: "user-a" },
				{ channelId: "chan-b", recipientId: "user-b" },
				{ channelId: "chan-c", recipientId: "user-c" },
			],
			logger: { info: vi.fn(), warn },
			limit: 2,
		});
		expect(result.failures).toBe(1);
		expect(result.channels).toHaveLength(1);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(createDM).toHaveBeenCalledTimes(2);
	});
});
