/**
 * The local-runtime provider's enable state has to tell "nothing installed"
 * apart from "the models directory could not be read". A first run legitimately
 * has no `models/` dir (ENOENT); ENOTDIR / EACCES / EIO leave the contents
 * unknown, so reporting "No local model installed" sends the user to download
 * models that may already be sitting on disk.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILT_IN_PROVIDERS, type ProviderDefinition } from "./providers";

function localProvider(): ProviderDefinition {
	const def = BUILT_IN_PROVIDERS.find((p) => p.id === "eliza-local-inference");
	if (!def) throw new Error("eliza-local-inference provider is not registered");
	return def;
}

describe("eliza-local-inference enable state", () => {
	const previousStateDir = process.env.ELIZA_STATE_DIR;
	let stateDir = "";

	beforeEach(() => {
		stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-local-provider-"));
		process.env.ELIZA_STATE_DIR = stateDir;
	});

	afterEach(() => {
		if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
		else process.env.ELIZA_STATE_DIR = previousStateDir;
		fs.rmSync(stateDir, { recursive: true, force: true });
	});

	it("reports no model installed when the models directory does not exist yet", async () => {
		await expect(localProvider().getEnableState()).resolves.toEqual({
			enabled: false,
			reason: "No local model installed",
		});
	});

	it("names an unreadable models path instead of claiming no model is installed", async () => {
		const modelsPath = path.join(stateDir, "local-inference", "models");
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
		// Something else occupies the models path: readdir fails ENOTDIR, the
		// same class of error as EACCES/EIO, and none of them prove absence.
		fs.writeFileSync(modelsPath, "not a directory");

		const state = await localProvider().getEnableState();

		expect(state.enabled).toBe(false);
		expect(state.reason).not.toBe("No local model installed");
		expect(state.reason).toContain("ENOTDIR");
	});
});
