/** Exercises connector catalog lookup and input normalization behavior. */
import { describe, expect, it } from "vitest";
import {
  getConnectorAccountCatalogEntry,
  hasConnectorAccountCatalogEntry,
  normalizeConnectorCatalogId,
} from "./connector-account-catalog.js";

describe("connector account catalog lookup + normalization", () => {
  it("normalizes plugin prefixes and the twitter alias", () => {
    expect(normalizeConnectorCatalogId("@elizaos/plugin-telegram")).toBe(
      "telegram",
    );
    expect(normalizeConnectorCatalogId("plugin-slack")).toBe("slack");
    expect(normalizeConnectorCatalogId("TWITTER")).toBe("x");
  });

  it("resolves aliases onto the canonical entry", () => {
    expect(getConnectorAccountCatalogEntry("twitter")?.connectorId).toBe("x");
    expect(getConnectorAccountCatalogEntry("gmail")?.connectorId).toBe(
      "google",
    );
    expect(
      getConnectorAccountCatalogEntry("google-workspace")?.connectorId,
    ).toBe("google");
    expect(getConnectorAccountCatalogEntry("@elizaos/plugin-x")?.provider).toBe(
      "x",
    );
  });

  it("reports membership and returns null for unknown connectors", () => {
    expect(hasConnectorAccountCatalogEntry("telegram")).toBe(true);
    expect(hasConnectorAccountCatalogEntry("twitter")).toBe(true);
    expect(hasConnectorAccountCatalogEntry("discord")).toBe(false);
    expect(hasConnectorAccountCatalogEntry(undefined)).toBe(false);
    expect(hasConnectorAccountCatalogEntry(null)).toBe(false);
    expect(getConnectorAccountCatalogEntry("nope")).toBeNull();
  });
});
