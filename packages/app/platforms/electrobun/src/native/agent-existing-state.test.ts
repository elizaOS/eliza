import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("electrobun/bun", () => ({ Utils: {} }));

import { inspectExistingElizaInstall } from "./agent";

it("discovers a prior dot-directory installation rather than reporting a fresh install", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-state-upgrade-"));
	try {
		const state = path.join(home, ".eliza");
		fs.mkdirSync(state);
		fs.writeFileSync(path.join(state, "eliza.json"), "{}");
		expect(
			inspectExistingElizaInstall({ homedir: home, env: {} }),
		).toMatchObject({
			detected: true,
			stateDir: state,
			source: "legacy-dot-state-dir",
		});
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});
