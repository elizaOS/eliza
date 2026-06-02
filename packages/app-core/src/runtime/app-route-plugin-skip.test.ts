import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getSkippedAppRoutePluginIds } from "./eliza.ts";

const ENV_KEY = "ELIZA_SKIP_APP_ROUTE_PLUGINS";

describe("getSkippedAppRoutePluginIds", () => {
  let savedValue: string | undefined;

  beforeEach(() => {
    savedValue = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (savedValue === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedValue;
    }
  });

  it("returns an empty set when the knob is unset (default unchanged: every app-route plugin loads)", () => {
    expect(getSkippedAppRoutePluginIds().size).toBe(0);
  });

  it("returns an empty set for an empty string", () => {
    process.env[ENV_KEY] = "";
    expect(getSkippedAppRoutePluginIds().size).toBe(0);
  });

  it("returns an empty set for whitespace-only input", () => {
    process.env[ENV_KEY] = "   ";
    expect(getSkippedAppRoutePluginIds().size).toBe(0);
  });

  it("parses a comma-separated list, trimming each id and dropping blank segments", () => {
    process.env[ENV_KEY] = "lifeops,training, steward";
    const skipped = getSkippedAppRoutePluginIds();
    expect(skipped).toEqual(new Set(["lifeops", "training", "steward"]));
  });

  it("ignores trailing and duplicate commas without producing empty entries", () => {
    process.env[ENV_KEY] = "lifeops,,training,";
    const skipped = getSkippedAppRoutePluginIds();
    expect(skipped).toEqual(new Set(["lifeops", "training"]));
    expect(skipped.has("")).toBe(false);
  });
});
