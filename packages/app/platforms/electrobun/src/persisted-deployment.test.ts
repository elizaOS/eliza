import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPersistedDeployment } from "./persisted-deployment";

const CLOUD_TARGET = {
	deploymentTarget: {
		runtime: "cloud",
		remoteApiBase: "https://agent.example.test",
		remoteAccessToken: "token-123",
	},
};

describe("readPersistedDeployment", () => {
	let root: string;
	let stateHome: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "persisted-deployment-"));
		stateHome = path.join(root, "state");
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	function writeConfig(namespace: string, filename: string, value: object) {
		const dir = path.join(stateHome, namespace);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, filename), JSON.stringify(value));
	}

	it("reads the namespaced config file for a branded build", () => {
		writeConfig("acme", "acme.json", CLOUD_TARGET);

		const deployment = readPersistedDeployment({
			XDG_STATE_HOME: stateHome,
			ELIZA_NAMESPACE: "acme",
		});

		expect(deployment).toEqual({
			runtime: "cloud",
			remoteApiBase: "https://agent.example.test",
			remoteAccessToken: "token-123",
		});
	});

	it("prefers the namespaced config over a legacy eliza.json", () => {
		writeConfig("acme", "acme.json", CLOUD_TARGET);
		writeConfig("acme", "eliza.json", {
			deploymentTarget: { runtime: "local" },
		});

		const deployment = readPersistedDeployment({
			XDG_STATE_HOME: stateHome,
			ELIZA_NAMESPACE: "acme",
		});

		expect(deployment?.runtime).toBe("cloud");
	});

	it("falls back to eliza.json when a branded build has no namespaced config", () => {
		writeConfig("acme", "eliza.json", CLOUD_TARGET);

		const deployment = readPersistedDeployment({
			XDG_STATE_HOME: stateHome,
			ELIZA_NAMESPACE: "acme",
		});

		expect(deployment?.runtime).toBe("cloud");
	});

	it("honors the ELIZA_CONFIG_PATH override", () => {
		const configPath = path.join(root, "custom.json");
		fs.writeFileSync(configPath, JSON.stringify(CLOUD_TARGET));

		const deployment = readPersistedDeployment({
			XDG_STATE_HOME: stateHome,
			ELIZA_NAMESPACE: "acme",
			ELIZA_CONFIG_PATH: configPath,
		});

		expect(deployment?.runtime).toBe("cloud");
	});
});
