/**
 * Pure unit coverage for the ELIZA_SKIP_PLUGINS preservation helpers that
 * dev-server's runtime bootstrap loop threads through the PGlite-recovery
 * retry. No server boot involved; process.env is saved and restored around
 * each test.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  mergedRecoverySkipPlugins,
  restoreOperatorSkipPlugins,
} from "./skip-plugins-env";

const originalSkipPlugins = process.env.ELIZA_SKIP_PLUGINS;

afterEach(() => {
  if (originalSkipPlugins === undefined) {
    delete process.env.ELIZA_SKIP_PLUGINS;
  } else {
    process.env.ELIZA_SKIP_PLUGINS = originalSkipPlugins;
  }
});

describe("restoreOperatorSkipPlugins", () => {
  it("settles the env var back to the operator's value after the recovery retry used it as scratch", () => {
    process.env.ELIZA_SKIP_PLUGINS = "plugin-sql,plugin-browser";
    restoreOperatorSkipPlugins("plugin-browser");
    expect(process.env.ELIZA_SKIP_PLUGINS).toBe("plugin-browser");
  });

  it("deletes the env var when the operator never set one", () => {
    process.env.ELIZA_SKIP_PLUGINS = "plugin-sql";
    restoreOperatorSkipPlugins(undefined);
    expect("ELIZA_SKIP_PLUGINS" in process.env).toBe(false);
  });
});

describe("mergedRecoverySkipPlugins", () => {
  it("unions operator skips with the crash-implicated list", () => {
    expect(
      mergedRecoverySkipPlugins("plugin-browser,plugin-vision", ["plugin-sql"]),
    ).toBe("plugin-browser,plugin-vision,plugin-sql");
  });

  it("dedupes overlap and drops whitespace-only segments in the operator list", () => {
    expect(
      mergedRecoverySkipPlugins(" plugin-browser, ,plugin-vision ", [
        "plugin-vision",
        "plugin-sql",
      ]),
    ).toBe("plugin-browser,plugin-vision,plugin-sql");
  });

  it("returns just the recovery list when the operator set nothing", () => {
    expect(mergedRecoverySkipPlugins(undefined, ["plugin-sql"])).toBe(
      "plugin-sql",
    );
  });

  it("preserves the operator list unchanged when recovery implicates nothing", () => {
    expect(mergedRecoverySkipPlugins("plugin-browser", [])).toBe(
      "plugin-browser",
    );
  });

  it("treats not-set and empty-string operator values identically (explicit undefined branch)", () => {
    // The undefined case is a distinct "operator never set the var" state
    // handled by an explicit branch (not an `?? ""` default); both it and a
    // set-but-empty value must yield exactly the recovery list.
    expect(
      mergedRecoverySkipPlugins(undefined, ["plugin-sql", "plugin-sql"]),
    ).toBe("plugin-sql");
    expect(mergedRecoverySkipPlugins("", ["plugin-sql"])).toBe("plugin-sql");
  });
});
