/** Verifies connection updates share the host config without accessing a DOM window. */
import {
	clearElizaApiBase,
	clearElizaApiToken,
	getBootConfig,
	getElizaApiBase,
	getElizaApiToken,
	setBootConfig,
	setElizaApiBase,
	setElizaApiToken,
} from "@elizaos/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const original = getBootConfig();
const hostSetting = { enabled: true };

beforeEach(() => {
	setBootConfig({ ...original, fixtureHostSetting: hostSetting });
	vi.stubGlobal(
		"window",
		new Proxy(
			{},
			{
				get() {
					throw new Error("Connection state accessed window");
				},
				set() {
					throw new Error("Connection state mutated window");
				},
				deleteProperty() {
					throw new Error("Connection state mutated window");
				},
			},
		),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	setBootConfig(original);
});

it("keeps endpoint and token updates in the shared host config", () => {
	setElizaApiBase("  https://agent.example.test  ");
	setElizaApiToken("  fixture-token  ");
	expect(getElizaApiBase()).toBe("https://agent.example.test");
	expect(getElizaApiToken()).toBe("fixture-token");
	expect(getBootConfig().fixtureHostSetting).toBe(hostSetting);

	clearElizaApiBase();
	expect(getElizaApiBase()).toBeUndefined();
	expect(getBootConfig()).not.toHaveProperty("apiBase");
	expect(getElizaApiToken()).toBe("fixture-token");

	setElizaApiBase("https://replacement.example.test");
	clearElizaApiToken();
	expect(getElizaApiBase()).toBe("https://replacement.example.test");
	expect(getBootConfig()).not.toHaveProperty("apiToken");
	expect(getBootConfig().fixtureHostSetting).toBe(hostSetting);
});

it("treats blank connection values as absent without discarding host settings", () => {
	setElizaApiBase(" \t ");
	setElizaApiToken("\n ");
	expect(getElizaApiBase()).toBeUndefined();
	expect(getElizaApiToken()).toBeUndefined();
	expect(getBootConfig().fixtureHostSetting).toBe(hostSetting);
});
