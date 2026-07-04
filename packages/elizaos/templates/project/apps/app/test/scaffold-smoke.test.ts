/**
 * Scaffold smoke test that verifies generated app identity placeholders were
 * replaced with concrete values.
 */

/**
 * Basic scaffold integrity checks for a generated project app.
 *
 * The test is deterministic and verifies template tokens resolved into a usable
 * application identity without booting the renderer.
 */
import { describe, expect, it } from "vitest";
import appConfig from "../app.config";

describe("project scaffold", () => {
  it("has a resolved application identity", () => {
    const identityValues = [
      appConfig.appName,
      appConfig.appId,
      appConfig.cliName,
      appConfig.namespace,
      appConfig.desktop.bundleId,
      appConfig.desktop.urlScheme,
    ];

    expect(identityValues.every((value) => value.trim().length > 0)).toBe(true);
    expect(identityValues.filter((value) => value.includes("__"))).toEqual([]);
    expect(appConfig.desktop.bundleId).toBe(appConfig.appId);
    expect(appConfig.desktop.urlScheme).toBe(appConfig.cliName);
  });
});
