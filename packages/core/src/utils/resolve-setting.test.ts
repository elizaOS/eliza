import { describe, expect, it } from "vitest";
import { resolveSetting, type SettingReader } from "./resolve-setting";

describe("resolveSetting", () => {
	it("returns runtime setting when defined", () => {
		const runtime: SettingReader = {
			getSetting: (key) => (key === "foo" ? "bar" : null),
		};
		expect(resolveSetting(runtime, "foo")).toBe("bar");
	});

	it("returns runtime setting for boolean", () => {
		const runtime: SettingReader = {
			getSetting: (key) => (key === "enabled" ? true : null),
		};
		expect(resolveSetting(runtime, "enabled")).toBe("true");
	});

	it("returns runtime setting for number", () => {
		const runtime: SettingReader = {
			getSetting: (key) => (key === "timeout" ? 30 : null),
		};
		expect(resolveSetting(runtime, "timeout")).toBe("30");
	});

	it("falls back to env when runtime returns null", () => {
		const runtime: SettingReader = { getSetting: () => null };
		expect(
			resolveSetting(runtime, "HOME", { env: { HOME: "/home/user" } }),
		).toBe("/home/user");
	});

	it("falls back to env when runtime returns undefined", () => {
		const runtime: SettingReader = { getSetting: () => undefined };
		expect(
			resolveSetting(runtime, "HOME", { env: { HOME: "/home/user" } }),
		).toBe("/home/user");
	});

	it("falls back to env when runtime is null", () => {
		expect(resolveSetting(null, "HOME", { env: { HOME: "/home/user" } })).toBe(
			"/home/user",
		);
	});

	it("falls back to env when runtime is undefined", () => {
		expect(
			resolveSetting(undefined, "HOME", { env: { HOME: "/home/user" } }),
		).toBe("/home/user");
	});

	it("returns defaultValue when neither runtime nor env", () => {
		const runtime: SettingReader = { getSetting: () => null };
		expect(
			resolveSetting(runtime, "MISSING", { defaultValue: "fallback" }),
		).toBe("fallback");
	});

	it("returns undefined when no value found", () => {
		const runtime: SettingReader = { getSetting: () => null };
		expect(resolveSetting(runtime, "MISSING")).toBeUndefined();
	});

	it("runtime takes priority over env", () => {
		const runtime: SettingReader = {
			getSetting: (key) => (key === "TOKEN" ? "runtime-token" : null),
		};
		expect(
			resolveSetting(runtime, "TOKEN", { env: { TOKEN: "env-token" } }),
		).toBe("runtime-token");
	});

	it("runtime takes priority over defaultValue", () => {
		const runtime: SettingReader = {
			getSetting: (key) => (key === "TOKEN" ? "runtime-token" : null),
		};
		expect(
			resolveSetting(runtime, "TOKEN", { defaultValue: "default-token" }),
		).toBe("runtime-token");
	});

	it("env takes priority over defaultValue", () => {
		const runtime: SettingReader = { getSetting: () => null };
		expect(
			resolveSetting(runtime, "TOKEN", {
				env: { TOKEN: "env-token" },
				defaultValue: "default-token",
			}),
		).toBe("env-token");
	});
});
