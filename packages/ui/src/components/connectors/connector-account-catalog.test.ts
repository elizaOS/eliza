/**
 * Guards for #12087 Item 10 (arch-audit roles-permissions): per-connector role
 * defaults now live in the server-authoritative `@elizaos/shared` catalog, and
 * the UI reads them instead of hardcoding literals.
 *
 *   1. UI-reads-catalog: every plugin-managed account option the UI renders
 *      carries the same `defaultRole` / `defaultPurpose` / `supportsOAuth` as
 *      the shared `CONNECTOR_ACCOUNT_CATALOG`. If the two ever drift, this test
 *      fails.
 *   2. Grep guard: the deprecated hardcoded `defaultRole` / `defaultPurpose` /
 *      `supportsOAuth` literals are gone from `connector-account-options.ts` —
 *      the old duplicated gate is removed from the executable path.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CONNECTOR_ACCOUNT_CATALOG,
  getConnectorAccountCatalogEntry,
} from "@elizaos/shared/connector-account-catalog";
import { describe, expect, it } from "vitest";
import {
  CONNECTOR_PLUGIN_MANAGED_ACCOUNT_OPTIONS,
  getConnectorPluginManagedAccountOption,
} from "./connector-account-options";

describe("UI reads connector defaults from the shared catalog", () => {
  it("projects every catalog entry into a plugin-managed option", () => {
    expect(CONNECTOR_PLUGIN_MANAGED_ACCOUNT_OPTIONS).toHaveLength(
      CONNECTOR_ACCOUNT_CATALOG.length,
    );
  });

  for (const entry of CONNECTOR_ACCOUNT_CATALOG) {
    it(`resolves ${entry.connectorId} defaults straight from the catalog`, () => {
      const option = getConnectorPluginManagedAccountOption(entry.connectorId);
      expect(option).not.toBeNull();
      expect(option?.defaultRole).toBe(entry.defaultRole);
      expect([...(option?.defaultPurpose ?? [])]).toEqual([
        ...entry.defaultPurpose,
      ]);
      expect(option?.supportsOAuth).toBe(entry.supportsOAuth);
      expect(option?.oauthCapabilities).toEqual(entry.oauthCapabilities);
      // The UI must not invent values the catalog does not carry.
      expect(getConnectorAccountCatalogEntry(entry.connectorId)).not.toBeNull();
    });
  }
});

describe("grep guard: no hardcoded connector-default literals in the UI", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./connector-account-options.ts", import.meta.url)),
    "utf8",
  );

  it("does not re-declare defaultRole/defaultPurpose/supportsOAuth as object literals", () => {
    // These would only appear as `defaultRole: "..."` etc. if the deprecated
    // hardcoded map came back. The interface declaration uses a type
    // annotation (`defaultRole: ConnectorAccountRole`) — allowed. We forbid the
    // string-literal assignment form specifically.
    expect(source).not.toMatch(/defaultRole:\s*["'](OWNER|AGENT|TEAM)["']/);
    expect(source).not.toMatch(/defaultPurpose:\s*\[/);
    expect(source).not.toMatch(/supportsOAuth:\s*(true|false)\b/);
  });

  it("imports the catalog from @elizaos/shared", () => {
    expect(source).toMatch(/@elizaos\/shared\/connector-account-catalog/);
  });
});
