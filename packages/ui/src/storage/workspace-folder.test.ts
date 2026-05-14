import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	clearStoredWorkspaceFolder,
	persistStoredWorkspaceFolder,
	readStoredWorkspaceFolder,
	WORKSPACE_FOLDER_STORAGE_KEY,
} from "./workspace-folder";

interface MemoryStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
	clear(): void;
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
		clear: () => map.clear(),
	};
}

describe("workspace-folder storage", () => {
	let storage: MemoryStorage;
	let originalWindow: typeof globalThis.window | undefined;

	beforeEach(() => {
		storage = makeStorage();
		originalWindow = (globalThis as { window?: typeof globalThis.window })
			.window;
		(globalThis as { window?: unknown }).window = { localStorage: storage };
	});

	afterEach(() => {
		(globalThis as { window?: unknown }).window = originalWindow;
	});

	it("returns null when nothing is stored", () => {
		expect(readStoredWorkspaceFolder()).toBeNull();
	});

	it("round-trips path + bookmark + adds updatedAt timestamp", () => {
		const before = Date.now();
		const persisted = persistStoredWorkspaceFolder({
			path: "/Users/x/workspace",
			bookmark: "base64bookmark",
		});
		expect(persisted.path).toBe("/Users/x/workspace");
		expect(persisted.bookmark).toBe("base64bookmark");
		expect(new Date(persisted.updatedAt).getTime()).toBeGreaterThanOrEqual(
			before,
		);
		const read = readStoredWorkspaceFolder();
		expect(read).toEqual(persisted);
	});

	it("accepts null bookmark (Flathub/Windows)", () => {
		persistStoredWorkspaceFolder({
			path: "/home/x/Milady",
			bookmark: null,
		});
		expect(readStoredWorkspaceFolder()?.bookmark).toBeNull();
	});

	it("returns null on malformed JSON without throwing", () => {
		storage.setItem(WORKSPACE_FOLDER_STORAGE_KEY, "not-json{");
		expect(readStoredWorkspaceFolder()).toBeNull();
	});

	it("returns null on JSON that fails the shape check", () => {
		storage.setItem(
			WORKSPACE_FOLDER_STORAGE_KEY,
			JSON.stringify({ path: "" }),
		);
		expect(readStoredWorkspaceFolder()).toBeNull();
	});

	it("clear removes the stored value", () => {
		persistStoredWorkspaceFolder({ path: "/p", bookmark: null });
		clearStoredWorkspaceFolder();
		expect(readStoredWorkspaceFolder()).toBeNull();
	});
});
