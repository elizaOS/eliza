import { describe, expect, it } from "vitest";
import { resolveStateDir } from "../src/utils/state-dir.ts";

const getHome = () => "/home/test";

function env(values: Record<string, string>): NodeJS.ProcessEnv {
	return values as NodeJS.ProcessEnv;
}

describe("resolveStateDir with XDG_STATE_HOME", () => {
	it("ignores a relative XDG_STATE_HOME and uses the default", () => {
		expect(
			resolveStateDir(env({ XDG_STATE_HOME: "relative/state" }), getHome),
		).toBe("/home/test/.local/state/eliza");
	});

	it("ignores a bare relative XDG_STATE_HOME", () => {
		expect(resolveStateDir(env({ XDG_STATE_HOME: "state" }), getHome)).toBe(
			"/home/test/.local/state/eliza",
		);
	});

	it("uses an absolute XDG_STATE_HOME", () => {
		expect(resolveStateDir(env({ XDG_STATE_HOME: "/srv/state" }), getHome)).toBe(
			"/srv/state/eliza",
		);
	});

	it("uses an absolute XDG_STATE_HOME with a custom namespace", () => {
		expect(
			resolveStateDir(
				env({ XDG_STATE_HOME: "/srv/state", ELIZA_NAMESPACE: "agent" }),
				getHome,
			),
		).toBe("/srv/state/agent");
	});

	it("uses the default when XDG_STATE_HOME is unset or empty", () => {
		expect(resolveStateDir(env({}), getHome)).toBe(
			"/home/test/.local/state/eliza",
		);
		expect(resolveStateDir(env({ XDG_STATE_HOME: "" }), getHome)).toBe(
			"/home/test/.local/state/eliza",
		);
	});

	it("keeps ELIZA_STATE_DIR ahead of a relative XDG_STATE_HOME", () => {
		expect(
			resolveStateDir(
				env({
					ELIZA_STATE_DIR: "/explicit/state",
					XDG_STATE_HOME: "relative/state",
				}),
				getHome,
			),
		).toBe("/explicit/state");
	});
});
