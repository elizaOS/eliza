import { describe, expect, it, vi } from "vitest";

vi.mock("../../electrobun.config", () => ({
	default: { app: { identifier: "x" } },
}));
vi.mock("../local-adhoc-sign-macos", () => ({ signLocalAppBundle: vi.fn() }));
vi.mock("../postwrap-diagnostics", () => ({
	resolveWrapperBundlePath: () => "/tmp/bundle.app",
}));

import { shouldSignDevMacApp } from "../sign-dev-macos-app.ts";

const DEV_ENV = {
	ELECTROBUN_BUILD_ENV: "dev",
	ELECTROBUN_OS: "macos",
	ELECTROBUN_SKIP_CODESIGN: "1",
};

describe("shouldSignDevMacApp", () => {
	it("signs only on darwin with dev/macos/skip-codesign env", () => {
		expect(shouldSignDevMacApp(DEV_ENV, "darwin")).toBe(true);
	});

	it("refuses on non-darwin hosts", () => {
		expect(shouldSignDevMacApp(DEV_ENV, "linux")).toBe(false);
		expect(shouldSignDevMacApp(DEV_ENV, "win32")).toBe(false);
	});

	it("refuses when env flags are missing", () => {
		expect(shouldSignDevMacApp({}, "darwin")).toBe(false);
		expect(
			shouldSignDevMacApp(
				{ ...DEV_ENV, ELECTROBUN_BUILD_ENV: "prod" },
				"darwin",
			),
		).toBe(false);
		expect(
			shouldSignDevMacApp({ ...DEV_ENV, ELECTROBUN_OS: "ios" }, "darwin"),
		).toBe(false);
		expect(
			shouldSignDevMacApp(
				{ ...DEV_ENV, ELECTROBUN_SKIP_CODESIGN: "0" },
				"darwin",
			),
		).toBe(false);
	});
});
