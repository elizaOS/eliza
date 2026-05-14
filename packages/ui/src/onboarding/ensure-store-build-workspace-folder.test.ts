import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureStoreBuildWorkspaceFolder } from "./ensure-store-build-workspace-folder";
import {
	clearStoredWorkspaceFolder,
	persistStoredWorkspaceFolder,
	readStoredWorkspaceFolder,
} from "../storage/workspace-folder";

let mockedVariant: "store" | "direct" = "store";

vi.mock("../build-variant", () => ({
	isStoreBuild: () => mockedVariant === "store",
	isDirectBuild: () => mockedVariant === "direct",
	getBuildVariant: () => mockedVariant,
	BUILD_VARIANTS: ["store", "direct"] as const,
	DEFAULT_BUILD_VARIANT: "direct" as const,
}));

vi.mock("../bridge/electrobun-rpc", () => ({
	pickDesktopWorkspaceFolder: vi.fn(),
	resolveDesktopWorkspaceFolderBookmark: vi.fn(),
}));

import {
	pickDesktopWorkspaceFolder,
	resolveDesktopWorkspaceFolderBookmark,
} from "../bridge/electrobun-rpc";

interface MemoryStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

function makeStorage(): MemoryStorage {
	const map = new Map<string, string>();
	return {
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => {
			map.set(key, value);
		},
		removeItem: (key) => {
			map.delete(key);
		},
	};
}

describe("ensureStoreBuildWorkspaceFolder", () => {
	let originalWindow: typeof globalThis.window | undefined;

	beforeEach(() => {
		mockedVariant = "store";
		originalWindow = (globalThis as { window?: typeof globalThis.window })
			.window;
		(globalThis as { window?: unknown }).window = {
			localStorage: makeStorage(),
		};
		(pickDesktopWorkspaceFolder as ReturnType<typeof vi.fn>).mockReset();
		(
			resolveDesktopWorkspaceFolderBookmark as ReturnType<typeof vi.fn>
		).mockReset();
	});

	afterEach(() => {
		(globalThis as { window?: unknown }).window = originalWindow;
		clearStoredWorkspaceFolder();
	});

	it("skips when not a store build", async () => {
		mockedVariant = "direct";
		const result = await ensureStoreBuildWorkspaceFolder();
		expect(result).toEqual({ kind: "skipped", reason: "non-store-build" });
	});

	it("prompts the picker on first run and persists the result", async () => {
		(pickDesktopWorkspaceFolder as ReturnType<typeof vi.fn>).mockResolvedValue(
			{
				canceled: false,
				path: "/Users/x/Milady",
				bookmark: "base64Bookmark",
			},
		);
		const result = await ensureStoreBuildWorkspaceFolder();
		expect(result.kind).toBe("stored");
		if (result.kind !== "stored") return;
		expect(result.freshlyPicked).toBe(true);
		expect(result.folder.path).toBe("/Users/x/Milady");
		expect(result.folder.bookmark).toBe("base64Bookmark");
		expect(readStoredWorkspaceFolder()?.path).toBe("/Users/x/Milady");
	});

	it("returns canceled when the user dismisses the picker", async () => {
		(pickDesktopWorkspaceFolder as ReturnType<typeof vi.fn>).mockResolvedValue(
			{ canceled: true, path: "", bookmark: null },
		);
		const result = await ensureStoreBuildWorkspaceFolder();
		expect(result).toEqual({ kind: "canceled" });
	});

	it("replays stored value without re-resolving when there is no bookmark", async () => {
		persistStoredWorkspaceFolder({ path: "/home/x/Milady", bookmark: null });
		const result = await ensureStoreBuildWorkspaceFolder();
		expect(result.kind).toBe("stored");
		if (result.kind !== "stored") return;
		expect(result.freshlyPicked).toBe(false);
		expect(result.folder.path).toBe("/home/x/Milady");
		expect(pickDesktopWorkspaceFolder).not.toHaveBeenCalled();
		expect(resolveDesktopWorkspaceFolderBookmark).not.toHaveBeenCalled();
	});

	it("re-resolves a stored macOS bookmark and returns the fresh path", async () => {
		persistStoredWorkspaceFolder({
			path: "/Users/x/Milady",
			bookmark: "base64Bookmark",
		});
		(
			resolveDesktopWorkspaceFolderBookmark as ReturnType<typeof vi.fn>
		).mockResolvedValue({ ok: true, path: "/Users/x/Milady" });
		const result = await ensureStoreBuildWorkspaceFolder();
		expect(result.kind).toBe("stored");
		if (result.kind !== "stored") return;
		expect(result.freshlyPicked).toBe(false);
		expect(resolveDesktopWorkspaceFolderBookmark).toHaveBeenCalledWith(
			"base64Bookmark",
		);
	});

	it("clears stored value + reports stale-bookmark on resolve failure", async () => {
		persistStoredWorkspaceFolder({
			path: "/Users/x/Milady",
			bookmark: "expiredBookmark",
		});
		(
			resolveDesktopWorkspaceFolderBookmark as ReturnType<typeof vi.fn>
		).mockResolvedValue({ ok: false, path: "" });
		const result = await ensureStoreBuildWorkspaceFolder();
		expect(result).toEqual({
			kind: "stale-bookmark",
			oldPath: "/Users/x/Milady",
		});
		expect(readStoredWorkspaceFolder()).toBeNull();
	});

	it("forcePicker bypasses stored value and re-prompts", async () => {
		persistStoredWorkspaceFolder({ path: "/old", bookmark: null });
		(pickDesktopWorkspaceFolder as ReturnType<typeof vi.fn>).mockResolvedValue(
			{ canceled: false, path: "/new", bookmark: null },
		);
		const result = await ensureStoreBuildWorkspaceFolder({ forcePicker: true });
		expect(result.kind).toBe("stored");
		if (result.kind !== "stored") return;
		expect(result.folder.path).toBe("/new");
		expect(result.freshlyPicked).toBe(true);
	});
});
