import { afterEach, describe, expect, it, vi } from "vitest";

const SAVED_ENV = {
	ELIZA_PLATFORM: process.env.ELIZA_PLATFORM,
	ELIZA_MOBILE_PLATFORM: process.env.ELIZA_MOBILE_PLATFORM,
	ELIZA_ANDROID_LOCAL_BACKEND: process.env.ELIZA_ANDROID_LOCAL_BACKEND,
};

function restoreEnv(): void {
	for (const [key, value] of Object.entries(SAVED_ENV)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

describe("@elizaos/plugin-capacitor-bridge index", () => {
	afterEach(() => {
		restoreEnv();
	});

	it("does not boot the Android bridge when desktop code imports bridge helpers", async () => {
		vi.resetModules();
		delete process.env.ELIZA_PLATFORM;
		delete process.env.ELIZA_MOBILE_PLATFORM;
		delete process.env.ELIZA_ANDROID_LOCAL_BACKEND;

		const bridge = await import("./index.ts");

		expect(bridge.isMobileFsShimInstalled()).toBe(false);
		expect(process.env.ELIZA_PLATFORM).toBeUndefined();
		expect(process.env.ELIZA_MOBILE_PLATFORM).toBeUndefined();
		expect(process.env.ELIZA_ANDROID_LOCAL_BACKEND).toBeUndefined();
	});
});
