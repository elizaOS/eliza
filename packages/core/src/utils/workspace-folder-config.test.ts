import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	clearWorkspaceFolderConfig,
	readWorkspaceFolderConfig,
	workspaceFolderConfigPath,
	writeWorkspaceFolderConfig,
} from "./workspace-folder-config";

describe("workspace-folder-config", () => {
	let stateDir: string;
	let env: NodeJS.ProcessEnv;

	beforeEach(() => {
		stateDir = mkdtempSync(join(os.tmpdir(), "wf-config-"));
		env = { MILADY_STATE_DIR: stateDir };
	});

	afterEach(() => {
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("returns null when no config exists", () => {
		expect(readWorkspaceFolderConfig(env)).toBeNull();
	});

	it("round-trips path + bookmark + adds updatedAt timestamp", () => {
		const before = Date.now();
		const written = writeWorkspaceFolderConfig(
			{ path: "/Users/x/workspace", bookmark: "base64bookmark" },
			env,
		);
		expect(written.path).toBe("/Users/x/workspace");
		expect(written.bookmark).toBe("base64bookmark");
		expect(new Date(written.updatedAt).getTime()).toBeGreaterThanOrEqual(
			before,
		);
		expect(readWorkspaceFolderConfig(env)).toEqual(written);
	});

	it("accepts null bookmark (Flathub / Windows AppContainer)", () => {
		writeWorkspaceFolderConfig({ path: "/home/x/Milady", bookmark: null }, env);
		expect(readWorkspaceFolderConfig(env)?.bookmark).toBeNull();
	});

	it("returns null when the file is malformed JSON", () => {
		const path = workspaceFolderConfigPath(env);
		writeWorkspaceFolderConfig({ path: "/x", bookmark: null }, env);
		writeFileSync(path, "not-json{", "utf8");
		expect(readWorkspaceFolderConfig(env)).toBeNull();
	});

	it("clear removes the stored config", () => {
		writeWorkspaceFolderConfig({ path: "/x", bookmark: null }, env);
		clearWorkspaceFolderConfig(env);
		expect(readWorkspaceFolderConfig(env)).toBeNull();
	});

	it("clear is idempotent (no throw when nothing to clear)", () => {
		expect(() => clearWorkspaceFolderConfig(env)).not.toThrow();
	});

	it("honors MILADY_STATE_DIR for file location", () => {
		expect(workspaceFolderConfigPath(env)).toBe(
			join(stateDir, "workspace-folder.json"),
		);
	});

	it("honors ELIZA_STATE_DIR when MILADY_STATE_DIR is unset", () => {
		const env2: NodeJS.ProcessEnv = { ELIZA_STATE_DIR: stateDir };
		expect(workspaceFolderConfigPath(env2)).toBe(
			join(stateDir, "workspace-folder.json"),
		);
	});
});
