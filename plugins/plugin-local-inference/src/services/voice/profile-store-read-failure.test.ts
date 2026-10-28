import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VoiceProfileStore } from "./profile-store";

const roots: string[] = [];

async function makeStore(): Promise<{ root: string; store: VoiceProfileStore }> {
	const root = await mkdtemp(path.join(tmpdir(), "voice-profile-read-failure-"));
	roots.push(root);
	const store = new VoiceProfileStore({ rootDir: root });
	await store.init();
	return { root, store };
}

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

describe("VoiceProfileStore profile file reads", () => {
	it("still reports a genuinely absent profile as null", async () => {
		const { store } = await makeStore();
		await expect(store.get("absent-profile")).resolves.toBeNull();
	});

	it("surfaces an unreadable profile file instead of reporting it missing", async () => {
		const { root, store } = await makeStore();
		// A directory with the profile's file name reads to EISDIR — the file
		// exists, so "no such profile" is the wrong answer for callers (the
		// management routes answer 404 and list() drops the row).
		await mkdir(path.join(root, "profiles", "unreadable-profile.json"));
		await expect(store.get("unreadable-profile")).rejects.toMatchObject({
			code: "EISDIR",
		});
	});
});
