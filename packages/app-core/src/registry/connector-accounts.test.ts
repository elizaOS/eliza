// Tests for the OWNER+AGENT connector schema extension and the
// `normalizeConnectorAuth` legacy-auto-map. Backwards compat: existing
// manifests that only declare `auth` must keep loading and end up with a
// populated `accounts.agent`.

import { describe, expect, it } from "vitest";
import { loadRegistryFromRawEntries, normalizeConnectorAuth } from "./loader";
import {
  type AccountConfig,
  type ConnectorEntry,
  connectorEntrySchema,
} from "./schema";

const baseConnector = {
  id: "test-connector",
  name: "Test Connector",
  kind: "connector" as const,
  subtype: "messaging" as const,
  source: "bundled" as const,
  tags: [],
  config: {},
  render: {
    visible: true,
    pinTo: [],
    style: "card" as const,
    group: "messaging",
    actions: [],
  },
  resources: {},
  dependsOn: [],
};

describe("connectorEntrySchema accounts field", () => {
  it("accepts an entry with no accounts block", () => {
    const parsed = connectorEntrySchema.parse(baseConnector);
    expect(parsed.accounts).toBeUndefined();
  });

  it("accepts an entry with both owner and agent sides", () => {
    const parsed = connectorEntrySchema.parse({
      ...baseConnector,
      accounts: {
        owner: {
          supported: true,
          authKind: "oauth-cloud",
          credentialKeys: ["MY_OWNER_TOKEN"],
          osSupport: ["darwin", "win32"],
        },
        agent: {
          supported: true,
          authKind: "api-key",
          credentialKeys: ["MY_AGENT_TOKEN"],
        },
      },
    });
    expect(parsed.accounts?.owner?.authKind).toBe("oauth-cloud");
    expect(parsed.accounts?.agent?.authKind).toBe("api-key");
    expect(parsed.accounts?.owner?.osSupport).toEqual(["darwin", "win32"]);
  });

  it("rejects an unknown authKind", () => {
    const result = connectorEntrySchema.safeParse({
      ...baseConnector,
      accounts: {
        agent: { supported: true, authKind: "not-a-real-kind" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("defaults credentialKeys to [] when omitted", () => {
    const parsed = connectorEntrySchema.parse({
      ...baseConnector,
      accounts: {
        agent: { supported: true, authKind: "none" },
      },
    });
    expect(parsed.accounts?.agent?.credentialKeys).toEqual([]);
  });
});

describe("normalizeConnectorAuth (legacy auth → accounts.agent)", () => {
  it("maps legacy oauth auth to accounts.agent with oauth-cloud", () => {
    const entry = connectorEntrySchema.parse({
      ...baseConnector,
      auth: { kind: "oauth", credentialKeys: ["FOO_TOKEN"] },
    });
    const normalized = normalizeConnectorAuth(entry);
    expect(normalized.accounts?.agent).toEqual<AccountConfig>({
      supported: true,
      authKind: "oauth-cloud",
      credentialKeys: ["FOO_TOKEN"],
    });
  });

  it("maps legacy token auth to accounts.agent with api-key", () => {
    const entry = connectorEntrySchema.parse({
      ...baseConnector,
      auth: { kind: "token", credentialKeys: ["BAR_TOKEN"] },
    });
    const normalized = normalizeConnectorAuth(entry);
    expect(normalized.accounts?.agent?.authKind).toBe("api-key");
    expect(normalized.accounts?.agent?.credentialKeys).toEqual(["BAR_TOKEN"]);
  });

  it("maps legacy none auth to accounts.agent with none", () => {
    const entry = connectorEntrySchema.parse({
      ...baseConnector,
      auth: { kind: "none", credentialKeys: [] },
    });
    const normalized = normalizeConnectorAuth(entry);
    expect(normalized.accounts?.agent?.authKind).toBe("none");
  });

  it("leaves explicit accounts untouched even when auth is also declared", () => {
    const entry = connectorEntrySchema.parse({
      ...baseConnector,
      auth: { kind: "oauth", credentialKeys: ["FOO_TOKEN"] },
      accounts: {
        owner: { supported: true, authKind: "local-app" },
      },
    });
    const normalized = normalizeConnectorAuth(entry);
    expect(normalized.accounts?.owner?.authKind).toBe("local-app");
    expect(normalized.accounts?.agent).toBeUndefined();
  });

  it("is a no-op when neither auth nor accounts is declared", () => {
    const entry = connectorEntrySchema.parse(baseConnector);
    const normalized = normalizeConnectorAuth(entry);
    expect(normalized.accounts).toBeUndefined();
  });
});

describe("loadRegistryFromRawEntries applies normalizeConnectorAuth", () => {
  it("populates accounts.agent for legacy-auth connectors at load time", () => {
    const registry = loadRegistryFromRawEntries([
      {
        file: "test/legacy.json",
        data: {
          ...baseConnector,
          id: "legacy-connector",
          auth: { kind: "oauth", credentialKeys: ["LEGACY_TOKEN"] },
        },
      },
    ]);
    const entry = registry.byId.get("legacy-connector") as ConnectorEntry;
    expect(entry.accounts?.agent?.authKind).toBe("oauth-cloud");
    expect(entry.accounts?.agent?.credentialKeys).toEqual(["LEGACY_TOKEN"]);
  });
});
