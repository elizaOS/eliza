/** Exercises the real full-browser navigation boundary without launching a user session. */
import { describe, expect, it } from "vitest";
import {
	systemBrowserEnvironment,
	validateSystemBrowserUrl,
} from "./system-browser";

describe("full browser navigation", () => {
	it("preserves authentication callback queries and fragments", () => {
		const url =
			"https://accounts.google.com/signin?continue=https%3A%2F%2Fgoogle.com#next";
		expect(validateSystemBrowserUrl(url)).toBe(url);
	});
	it.each([
		"javascript:alert(1)",
		"file:///tmp/page",
		"--no-sandbox",
		"https://user:password@example.com",
		"https://example.com:65536",
	])("rejects unsafe navigation %s", (url) => {
		expect(() => validateSystemBrowserUrl(url)).toThrow();
	});
});

describe("full browser process environment", () => {
	it("removes CEF loader overrides and preserves the authorized browser profile", () => {
		const env = {
			LD_PRELOAD: "./libcef.so:/opt/eliza/libvk_swiftshader.so",
			HOME: "/private/home",
			XDG_CONFIG_HOME: "/private/config",
			XDG_RUNTIME_DIR: "/private/runtime",
			ELIZA_BROWSER_NATIVE_SOCKET: "/private/socket",
		};
		expect(systemBrowserEnvironment(env)).toEqual({
			HOME: env.HOME,
			XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
			XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR,
			ELIZA_BROWSER_NATIVE_SOCKET: env.ELIZA_BROWSER_NATIVE_SOCKET,
		});
		expect(env.LD_PRELOAD).toContain("libcef.so");
	});
	it("retains unrelated loader settings and leaves an ordinary environment unchanged", () => {
		expect(
			systemBrowserEnvironment({
				LD_PRELOAD: "libtrace.so ./libcef.so:/lib/libcustom.so",
				LD_LIBRARY_PATH: "/custom/lib",
			}),
		).toEqual({
			LD_PRELOAD: "libtrace.so:/lib/libcustom.so",
			LD_LIBRARY_PATH: "/custom/lib",
		});
		expect(systemBrowserEnvironment({ HOME: "/private/home" })).toEqual({
			HOME: "/private/home",
		});
	});
});
