/**
 * Tests for the server-authoritative connector account catalog (#12087 Item 10).
 *
 * Two guarantees:
 *   1. Each plugin-managed connector declares its exact `defaultRole` /
 *      `defaultPurpose` / `supportsOAuth` in ONE place (this catalog). The
 *      per-connector table below is the frozen expectation that proves the
 *      refactor preserved the historical UI-map defaults (no behavior change).
 *   2. Lookup resolves canonical ids, provider ids, and aliases
 *      (twitter → x, gmail → google) identically to the old UI normalization.
 */

import { describe, expect, it } from "vitest";
import {
  CONNECTOR_ACCOUNT_CATALOG,
  type ConnectorAccountCatalogEntry,
  getConnectorAccountCatalogEntry,
  hasConnectorAccountCatalogEntry,
  normalizeConnectorCatalogId,
} from "./connector-account-catalog.js";

/**
 * Frozen expected defaults per connector — MUST match the historical UI-map
 * literals exactly. This is the "no behavior change" proof for the audit item.
 */
const EXPECTED: Record<
  string,
  Pick<
    ConnectorAccountCatalogEntry,
    "provider" | "defaultRole" | "defaultPurpose" | "supportsOAuth"
  >
> = {
  telegram: {
    provider: "telegram",
    defaultRole: "AGENT",
    defaultPurpose: ["messaging"],
    supportsOAuth: false,
  },
  signal: {
    provider: "signal",
    defaultRole: "OWNER",
    defaultPurpose: ["messaging"],
    supportsOAuth: false,
  },
  google: {
    provider: "google",
    defaultRole: "OWNER",
    defaultPurpose: ["messaging", "calendar", "drive", "meet", "contacts"],
    supportsOAuth: true,
  },
  x: {
    provider: "x",
    defaultRole: "OWNER",
    defaultPurpose: ["posting", "reading", "messaging"],
    supportsOAuth: true,
  },
  slack: {
    provider: "slack",
    defaultRole: "OWNER",
    defaultPurpose: ["messaging", "posting", "reading"],
    supportsOAuth: true,
  },
  whatsapp: {
    provider: "whatsapp",
    defaultRole: "AGENT",
    defaultPurpose: ["messaging"],
    supportsOAuth: false,
  },
};

describe("connector account catalog defaults", () => {
  it("declares exactly the expected plugin-managed connectors", () => {
    const ids = CONNECTOR_ACCOUNT_CATALOG.map((e) => e.connectorId).sort();
    expect(ids).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [connectorId, expected] of Object.entries(EXPECTED)) {
    it(`pins ${connectorId} default role/purpose/oauth (no behavior change)`, () => {
      const entry = getConnectorAccountCatalogEntry(connectorId);
      expect(entry).not.toBeNull();
      expect(entry?.provider).toBe(expected.provider);
      expect(entry?.defaultRole).toBe(expected.defaultRole);
      expect([...(entry?.defaultPurpose ?? [])]).toEqual(
        expected.defaultPurpose,
      );
      expect(entry?.supportsOAuth).toBe(expected.supportsOAuth);
    });
  }

  it("declares Google's OAuth capability ids once for generic consumers", () => {
    expect(
      getConnectorAccountCatalogEntry("google")?.oauthCapabilities?.map(
        (capability) => capability.id,
      ),
    ).toEqual([
      "gmail.read",
      "gmail.send",
      "gmail.manage",
      "calendar.read",
      "calendar.write",
      "drive.read",
      "drive.write",
      "meet.create",
      "meet.read",
      "people.read",
    ]);
  });
});

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
