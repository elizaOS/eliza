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
