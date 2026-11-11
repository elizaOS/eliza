import { describe, expect, it } from "vitest";
import { resolveSetting } from "../src/utils/environment";

describe("resolveSetting", () => {
	it("falls back to env when the runtime setting is an empty string", () => {
		expect(
			resolveSetting({ getSetting: () => "" }, "K", { env: { K: "from-env" } }),
		).toBe("from-env");
		expect(
			resolveSetting({ getSetting: () => "   " }, "K", {
				env: { K: "from-env" },
			}),
		).toBe("from-env");
	});

	it("falls back to the default when the runtime setting is empty and env is unset", () => {
		expect(
			resolveSetting({ getSetting: () => "" }, "K", {
				env: {},
				defaultValue: "default",
			}),
		).toBe("default");
		expect(
			resolveSetting({ getSetting: () => "" }, "K", { env: {} }),
		).toBeUndefined();
	});

	it("still returns a non-empty runtime setting ahead of env", () => {
		expect(
			resolveSetting({ getSetting: () => "from-runtime" }, "K", {
				env: { K: "from-env" },
			}),
		).toBe("from-runtime");
		expect(
			resolveSetting({ getSetting: () => "  from-runtime  " }, "K", {
				env: { K: "from-env" },
			}),
		).toBe("  from-runtime  ");
	});

	it("still returns false and zero runtime settings as strings", () => {
		expect(
			resolveSetting({ getSetting: () => false }, "K", {
				env: { K: "from-env" },
			}),
		).toBe("false");
		expect(
			resolveSetting({ getSetting: () => 0 }, "K", { env: { K: "from-env" } }),
		).toBe("0");
	});

	it("falls back to env when there is no runtime or the setting is null", () => {
		expect(resolveSetting(null, "K", { env: { K: "from-env" } })).toBe(
			"from-env",
		);
		expect(
			resolveSetting({ getSetting: () => null }, "K", {
				env: { K: "from-env" },
			}),
		).toBe("from-env");
	});
});
