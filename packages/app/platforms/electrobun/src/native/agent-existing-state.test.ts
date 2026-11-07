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

it("prefers the current state directory over an older dot-directory install", () => {
	const home = fs.mkdtempSync(
		path.join(os.tmpdir(), "desktop-state-priority-"),
	);
	try {
		const current = path.join(home, ".local", "state", "eliza");
		for (const state of [current, path.join(home, ".eliza")]) {
			fs.mkdirSync(state, { recursive: true });
			fs.writeFileSync(path.join(state, "eliza.json"), "{}");
		}
		expect(
			inspectExistingElizaInstall({ homedir: home, env: {} }),
		).toMatchObject({
			detected: true,
			stateDir: current,
			source: "default-state-dir",
		});
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

it("does not adopt another product's legacy state directory", () => {
	const home = fs.mkdtempSync(
		path.join(os.tmpdir(), "desktop-state-namespace-"),
	);
	try {
		const other = path.join(home, ".eliza");
		fs.mkdirSync(other);
		fs.writeFileSync(path.join(other, "eliza.json"), "{}");
		expect(
			inspectExistingElizaInstall({
				homedir: home,
				env: { ELIZA_NAMESPACE: "isolated-product" },
			}).detected,
		).toBe(false);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});
