
import { describe, it, expect } from "vitest";
import {
  getActivatedPlugins,
  getNewlyActivatedPlugin,
  getNewlyDeactivatedPlugin,
  PLUGIN_REQUIRED_SECRETS,
  ALL_MOCK_PLUGINS,
} from "./index.js";

describe("PLUGIN_REQUIRED_SECRETS", () => {
  it("contains only required=true keys for each plugin", () => {
    // mock-database has DATABASE_URL (required) and DATABASE_POOL_SIZE (optional)
    expect(PLUGIN_REQUIRED_SECRETS["mock-database"]).toEqual(["DATABASE_URL"]);
    expect(PLUGIN_REQUIRED_SECRETS["mock-database"]).not.toContain("DATABASE_POOL_SIZE");
  });

  it("has entries for all mock plugins", () => {
    for (const plugin of ALL_MOCK_PLUGINS) {
      expect(PLUGIN_REQUIRED_SECRETS).toHaveProperty(plugin.name);
    }
  });

  it("mock-payment requires exactly two keys", () => {
    expect(PLUGIN_REQUIRED_SECRETS["mock-payment"]).toEqual(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
  });
});

describe("getActivatedPlugins", () => {
  it("returns empty for no secrets", () => {
    expect(getActivatedPlugins({})).toEqual([]);
  });

  it("activates mock-weather when WEATHER_API_KEY present", () => {
    const activated = getActivatedPlugins({ WEATHER_API_KEY: "wk-123" });
    expect(activated).toContain("mock-weather");
  });

  it("does NOT activate mock-payment with only one of two secrets", () => {
    const activated = getActivatedPlugins({ STRIPE_SECRET_KEY: "sk_test" });
    expect(activated).not.toContain("mock-payment");
  });

  it("activates mock-payment when both secrets present", () => {
    const activated = getActivatedPlugins({
      STRIPE_SECRET_KEY: "sk_test",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
    });
    expect(activated).toContain("mock-payment");
  });

  it("does NOT activate if secret value is empty string", () => {
    const activated = getActivatedPlugins({ WEATHER_API_KEY: "" });
    expect(activated).not.toContain("mock-weather");
  });

  it("activates multiple plugins when all their secrets are present", () => {
    const activated = getActivatedPlugins({
      WEATHER_API_KEY: "wk-123",
      STRIPE_SECRET_KEY: "sk_test",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      DATABASE_URL: "postgres://x",
    });
    expect(activated).toContain("mock-weather");
    expect(activated).toContain("mock-payment");
    expect(activated).toContain("mock-database");
    expect(activated).not.toContain("mock-social"); // missing TWITTER_API_SECRET
  });

  it("activates mock-database with only required key (optional missing is fine)", () => {
    const activated = getActivatedPlugins({ DATABASE_URL: "postgres://x" });
    expect(activated).toContain("mock-database");
  });

  it("ignores unrelated secrets", () => {
    const activated = getActivatedPlugins({ RANDOM_KEY: "value", ANOTHER: "v2" });
    expect(activated).toEqual([]);
  });
});

describe("getNewlyActivatedPlugin", () => {
  it("returns null when nothing changes", () => {
    const before = { WEATHER_API_KEY: "wk-123" };
    const after = { WEATHER_API_KEY: "wk-123" };
    expect(getNewlyActivatedPlugin(before, after)).toBeNull();
  });

  it("detects new activation when secret is added", () => {
    const before = {};
    const after = { WEATHER_API_KEY: "wk-123" };
    expect(getNewlyActivatedPlugin(before, after)).toBe("mock-weather");
  });

  it("returns null when secret is removed (deactivation)", () => {
    const before = { WEATHER_API_KEY: "wk-123" };
    const after = {};
    expect(getNewlyActivatedPlugin(before, after)).toBeNull();
  });

  it("detects activation when second required secret is added", () => {
    const before = { STRIPE_SECRET_KEY: "sk_test" };
    const after = { STRIPE_SECRET_KEY: "sk_test", STRIPE_WEBHOOK_SECRET: "whsec_test" };
    expect(getNewlyActivatedPlugin(before, after)).toBe("mock-payment");
  });

  it("returns only the first newly activated plugin", () => {
    const before = {};
    const after = {
      WEATHER_API_KEY: "wk-123",
      DATABASE_URL: "postgres://x",
    };
    const result = getNewlyActivatedPlugin(before, after);
    // Should return one of the two — whichever comes first
    expect(["mock-weather", "mock-database"]).toContain(result);
  });

  it("returns null from empty to empty", () => {
    expect(getNewlyActivatedPlugin({}, {})).toBeNull();
  });
});

describe("getNewlyDeactivatedPlugin", () => {
  it("returns null when nothing changes", () => {
    expect(getNewlyDeactivatedPlugin({ WEATHER_API_KEY: "wk" }, { WEATHER_API_KEY: "wk" })).toBeNull();
  });

  it("detects deactivation when secret is removed", () => {
    expect(getNewlyDeactivatedPlugin({ WEATHER_API_KEY: "wk" }, {})).toBe("mock-weather");
  });

  it("returns null when secret is added (activation, not deactivation)", () => {
    expect(getNewlyDeactivatedPlugin({}, { WEATHER_API_KEY: "wk" })).toBeNull();
  });

  it("detects deactivation of multi-secret plugin when one key removed", () => {
    const before = { STRIPE_SECRET_KEY: "sk", STRIPE_WEBHOOK_SECRET: "wh" };
    const after = { STRIPE_SECRET_KEY: "sk" };
    expect(getNewlyDeactivatedPlugin(before, after)).toBe("mock-payment");
  });
});


describe("getNewlyDeactivatedPlugin — edge cases", () => {
  it("returns null from empty to empty", () => {
    expect(getNewlyDeactivatedPlugin({}, {})).toBeNull();
  });

  it("returns null when value changes but plugin stays active", () => {
    const before = { WEATHER_API_KEY: "old-value" };
    const after = { WEATHER_API_KEY: "new-value" };
    expect(getNewlyDeactivatedPlugin(before, after)).toBeNull();
  });

  it("returns null when unrelated key removed", () => {
    const before = { WEATHER_API_KEY: "wk", RANDOM: "x" };
    const after = { WEATHER_API_KEY: "wk" };
    expect(getNewlyDeactivatedPlugin(before, after)).toBeNull();
  });
});

describe("getActivatedPlugins — all four plugins simultaneously", () => {
  it("activates all 4 when all required secrets present", () => {
    const activated = getActivatedPlugins({
      WEATHER_API_KEY: "wk",
      STRIPE_SECRET_KEY: "sk",
      STRIPE_WEBHOOK_SECRET: "wh",
      TWITTER_API_KEY: "tk",
      TWITTER_API_SECRET: "ts",
      DATABASE_URL: "pg",
    });
    expect(activated).toHaveLength(4);
    expect(activated).toContain("mock-weather");
    expect(activated).toContain("mock-payment");
    expect(activated).toContain("mock-social");
    expect(activated).toContain("mock-database");
  });
});
