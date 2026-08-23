import { describe, expect, it } from "vitest";
import {
	detectClientPlatform,
	isDynamicLoadingAllowed,
} from "./platform-detect.ts";

function req(headers: Record<string, string | undefined>) {
	return { headers } as never;
}

describe("detectClientPlatform", () => {
	it("detects from the X-Eliza-Platform header", () => {
		expect(detectClientPlatform(req({ "x-eliza-platform": "ios" }))).toBe(
			"ios",
		);
		expect(detectClientPlatform(req({ "x-eliza-platform": "android" }))).toBe(
			"android",
		);
	});

	it("detects from Capacitor user agents", () => {
		expect(
			detectClientPlatform(req({ "user-agent": "Capacitor...iOS App" })),
		).toBe("ios");
		expect(
			detectClientPlatform(req({ "user-agent": "Capacitor...Android App" })),
		).toBe("android");
	});

	it("detects Electrobun desktop", () => {
		expect(detectClientPlatform(req({ "user-agent": "Electrobun/1.0" }))).toBe(
			"desktop",
		);
	});

	it("defaults to web", () => {
		expect(detectClientPlatform(req({}))).toBe("web");
		expect(detectClientPlatform(req({ "user-agent": "curl/8" }))).toBe("web");
	});
});

describe("isDynamicLoadingAllowed", () => {
	it("blocks store platforms, allows others", () => {
		expect(isDynamicLoadingAllowed("ios")).toBe(false);
		expect(isDynamicLoadingAllowed("android")).toBe(false);
		expect(isDynamicLoadingAllowed("web")).toBe(true);
		expect(isDynamicLoadingAllowed("desktop")).toBe(true);
	});
});
