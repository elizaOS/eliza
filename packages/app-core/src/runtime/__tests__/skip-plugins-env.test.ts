import { afterEach, describe, expect, it } from "vitest";
import {
  mergedRecoverySkipPlugins,
  restoreOperatorSkipPlugins,
} from "./skip-plugins-env.ts";

const ORIGINAL = process.env.ELIZA_SKIP_PLUGINS;

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.ELIZA_SKIP_PLUGINS;
  } else {
    process.env.ELIZA_SKIP_PLUGINS = ORIGINAL;
  }
});

describe("restoreOperatorSkipPlugins", () => {
  it("restores the operator value", () => {
    restoreOperatorSkipPlugins("plugin-a,plugin-b");
    expect(process.env.ELIZA_SKIP_PLUGINS).toBe("plugin-a,plugin-b");
  });

  it("deletes the env var when the operator value is undefined", () => {
    process.env.ELIZA_SKIP_PLUGINS = "stale";
    restoreOperatorSkipPlugins(undefined);
    expect(process.env.ELIZA_SKIP_PLUGINS).toBeUndefined();
  });
});

describe("mergedRecoverySkipPlugins", () => {
  it("unions operator and recovery lists with dedupe", () => {
    expect(mergedRecoverySkipPlugins("a, b", ["b", "c"])).toBe("a,b,c");
  });

  it("handles missing operator list", () => {
    expect(mergedRecoverySkipPlugins(undefined, ["x"])).toBe("x");
  });

  it("handles empty inputs", () => {
    expect(mergedRecoverySkipPlugins("", [])).toBe("");
    expect(mergedRecoverySkipPlugins(undefined, [])).toBe("");
  });

  it("trims and drops blank entries", () => {
    expect(mergedRecoverySkipPlugins(" a , ,b", [])).toBe("a,b");
  });
});
