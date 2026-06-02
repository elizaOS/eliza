import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getSkippedAppRoutePluginIds,
  normalizeAppRoutePluginId,
} from "./eliza.ts";

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

describe("normalizeAppRoutePluginId", () => {
  it("strips the @elizaos/plugin- prefix", () => {
    expect(normalizeAppRoutePluginId("@elizaos/plugin-lifeops")).toBe(
      "lifeops",
    );
  });

  it("strips -app / -ui / -routes suffixes", () => {
    expect(normalizeAppRoutePluginId("@elizaos/plugin-steward-app")).toBe(
      "steward",
    );
    expect(normalizeAppRoutePluginId("@elizaos/plugin-shopify-ui")).toBe(
      "shopify",
    );
    expect(normalizeAppRoutePluginId("@elizaos/plugin-documents-routes")).toBe(
      "documents",
    );
  });

  it("strips the :routes suffix", () => {
    expect(normalizeAppRoutePluginId("@elizaos/plugin-elizacloud:routes")).toBe(
      "elizacloud",
    );
  });

  it("lowercases and trims", () => {
    expect(normalizeAppRoutePluginId("  Hyperliquid-App  ")).toBe(
      "hyperliquid",
    );
  });

  it("is idempotent on an already-short alias (so short tokens match full ids)", () => {
    expect(normalizeAppRoutePluginId("steward")).toBe("steward");
    expect(normalizeAppRoutePluginId("@elizaos/plugin-steward-app")).toBe(
      normalizeAppRoutePluginId("steward"),
    );
  });
});
