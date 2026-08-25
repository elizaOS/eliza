/**
 * Behavioral coverage for projectConnectorSettings. Drives the real module:
 * empty and missing slack blocks, credential-versus-policy split, vault-ref
 * stripping, whitespace and non-string omission, settings-over-connectors
 * merge, account union/override, and skip of non-object accounts.
 */
import {
  connectorAccountCredentialSettingKey,
  connectorBaseCredentialSettingKey,
  type JsonValue,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";

import { formatVaultRef } from "./operations/vault-bridge.ts";
import { projectConnectorSettings } from "./project-connector-settings.ts";

function baseSecret(field: string): string {
  return connectorBaseCredentialSettingKey("slack", field);
}

function accountSecret(accountId: string, field: string): string {
  return connectorAccountCredentialSettingKey("slack", accountId, field);
}

describe("projectConnectorSettings", () => {
  it("passes settings through unchanged when neither lane has a slack object", () => {
    const settings: Record<string, JsonValue | undefined> = {
      theme: "dark",
      slack: undefined,
    };

    expect(projectConnectorSettings(settings, undefined)).toEqual({
      settings,
      secrets: {},
    });
    expect(projectConnectorSettings(settings, null)).toEqual({
      settings,
      secrets: {},
    });
    expect(projectConnectorSettings(settings, "connectors")).toEqual({
      settings,
      secrets: {},
    });
    expect(projectConnectorSettings(settings, ["slack"])).toEqual({
      settings,
      secrets: {},
    });
    expect(
      projectConnectorSettings(settings, { discord: { token: "x" } }),
    ).toEqual({
      settings,
      secrets: {},
    });
  });

  it("treats a missing, null, array, or scalar slack block as absent", () => {
    const settings = { keep: true };

    expect(projectConnectorSettings(settings, { slack: null })).toEqual({
      settings,
      secrets: {},
    });
    expect(projectConnectorSettings(settings, { slack: "enabled" })).toEqual({
      settings,
      secrets: {},
    });
    expect(projectConnectorSettings(settings, { slack: ["C123"] })).toEqual({
      settings,
      secrets: {},
    });
    expect(projectConnectorSettings({ ...settings, slack: 1 }, {})).toEqual({
      settings: { ...settings, slack: 1 },
      secrets: {},
    });
  });

  it("projects a single policy field and leaves the rest of settings intact", () => {
    const settings = { language: "en", nested: { a: 1 } };
    const result = projectConnectorSettings(settings, {
      slack: { enabled: true },
    });

    expect(result.settings.language).toBe("en");
    expect(result.settings.nested).toBe(settings.nested);
    expect(result.settings.slack).toEqual({ enabled: true });
    expect(result.secrets).toEqual({});
  });

  it("moves Slack credential strings into secrets and out of settings.slack", () => {
    const result = projectConnectorSettings(
      {},
      {
        slack: {
          appToken: "app-token",
          botToken: "bot-token",
          signingSecret: "signing-secret",
          userToken: "user-token",
          teamId: "T123",
        },
      },
    );

    expect(result.settings.slack).toEqual({ teamId: "T123" });
    expect(result.secrets).toEqual({
      [baseSecret("appToken")]: "app-token",
      [baseSecret("botToken")]: "bot-token",
      [baseSecret("signingSecret")]: "signing-secret",
      [baseSecret("userToken")]: "user-token",
    });
  });

  it("omits empty, whitespace, and non-string credentials from secrets", () => {
    const result = projectConnectorSettings(
      {},
      {
        slack: {
          appToken: "",
          botToken: "   ",
          signingSecret: 12,
          userToken: false,
          extra: null,
        },
      },
    );

    expect(result.settings.slack).toEqual({ extra: null });
    expect(result.secrets).toEqual({});
  });

  it("strips vault:// credential refs from both settings and secrets", () => {
    const botRef = formatVaultRef("connectors.slack.botToken");
    const result = projectConnectorSettings(
      {},
      {
        slack: {
          botToken: botRef,
          teamId: "Tvault",
        },
      },
    );

    expect(result.settings.slack).toEqual({ teamId: "Tvault" });
    expect(result.secrets).toEqual({});
    expect(JSON.stringify(result)).not.toContain(botRef);
  });

  it("keeps a vault:// prefix with no key because isVaultRef requires a key", () => {
    const result = projectConnectorSettings(
      {},
      { slack: { botToken: "vault://" } },
    );

    expect(result.settings.slack).toEqual({});
    expect(result.secrets).toEqual({ [baseSecret("botToken")]: "vault://" });
  });

  it("does not treat AppToken as a credential because the key set is case-sensitive", () => {
    const result = projectConnectorSettings(
      {},
      { slack: { AppToken: "not-secret" } },
    );

    expect(result.settings.slack).toEqual({ AppToken: "not-secret" });
    expect(result.secrets).toEqual({});
  });

  it("clones nested policy values so later input mutation does not leak", () => {
    const channels = ["C1", "C2"];
    const connectors = { slack: { channels } };
    const result = projectConnectorSettings({}, connectors);

    channels.push("C3");
    expect(result.settings.slack).toEqual({ channels: ["C1", "C2"] });
  });

  it("lets settings.slack policy override connectors.slack while keeping base-only keys", () => {
    const result = projectConnectorSettings(
      {
        slack: { enabled: false, region: "us-east" },
      },
      {
        slack: { enabled: true, teamId: "Tbase" },
      },
    );

    expect(result.settings.slack).toEqual({
      enabled: false,
      teamId: "Tbase",
      region: "us-east",
    });
    expect(result.secrets).toEqual({});
  });

  it("lets settings credentials override connectors credentials for the same field", () => {
    const result = projectConnectorSettings(
      { slack: { botToken: "from-settings" } },
      { slack: { botToken: "from-connectors", appToken: "from-connectors" } },
    );

    expect(result.settings.slack).toEqual({});
    expect(result.secrets).toEqual({
      [baseSecret("appToken")]: "from-connectors",
      [baseSecret("botToken")]: "from-settings",
    });
  });

  it("places a non-object accounts value on the policy lane instead of splitting it", () => {
    const result = projectConnectorSettings(
      {},
      { slack: { accounts: "all", enabled: true } },
    );

    expect(result.settings.slack).toEqual({
      accounts: "all",
      enabled: true,
    });
    expect(result.secrets).toEqual({});
  });

  it("skips non-object accounts instead of projecting them", () => {
    const result = projectConnectorSettings(
      {},
      {
        slack: {
          accounts: {
            missing: "not-an-object",
            alsoMissing: 3,
            listed: ["C1"],
          },
        },
      },
    );

    expect(result.settings.slack).toEqual({ accounts: {} });
    expect(result.secrets).toEqual({});
  });

  it("splits account policy from account credentials and keys secrets by account id", () => {
    const result = projectConnectorSettings(
      {},
      {
        slack: {
          accounts: {
            support: {
              teamId: "Tsupport",
              botToken: "support-bot",
              userToken: "support-user",
            },
            emptyCreds: {
              teamId: "Tempty",
            },
          },
        },
      },
    );

    expect(result.settings.slack).toEqual({
      accounts: {
        support: { teamId: "Tsupport" },
        emptyCreds: { teamId: "Tempty" },
      },
    });
    expect(result.secrets).toEqual({
      [accountSecret("support", "botToken")]: "support-bot",
      [accountSecret("support", "userToken")]: "support-user",
    });
    expect(result.secrets[baseSecret("botToken")]).toBeUndefined();
  });

  it("unions account ids and lets the settings account win on overlapping fields", () => {
    const result = projectConnectorSettings(
      {
        slack: {
          accounts: {
            east: { teamId: "Teast-settings", locale: "en" },
            west: { botToken: "west-settings" },
          },
        },
      },
      {
        slack: {
          accounts: {
            east: { teamId: "Teast-base", region: "us-east" },
            north: { teamId: "Tnorth" },
          },
        },
      },
    );

    expect(result.settings.slack).toEqual({
      accounts: {
        east: {
          teamId: "Teast-settings",
          region: "us-east",
          locale: "en",
        },
        north: { teamId: "Tnorth" },
        west: {},
      },
    });
    expect(result.secrets).toEqual({
      [accountSecret("west", "botToken")]: "west-settings",
    });
  });

  it("preserves base-then-override account insertion order when unioning ids", () => {
    const result = projectConnectorSettings(
      {
        slack: {
          accounts: {
            zeta: { teamId: "Tz" },
            alpha: { teamId: "Ta-settings" },
          },
        },
      },
      {
        slack: {
          accounts: {
            beta: { teamId: "Tb" },
            alpha: { teamId: "Ta-base" },
          },
        },
      },
    );

    expect(
      Object.keys((result.settings.slack as { accounts: object }).accounts),
    ).toEqual(["beta", "alpha", "zeta"]);
  });

  it("treats a non-object overlapping account as an empty override", () => {
    const result = projectConnectorSettings(
      {
        slack: {
          accounts: {
            east: "override-is-scalar",
          },
        },
      },
      {
        slack: {
          accounts: {
            east: { teamId: "Teast", locale: "en" },
          },
        },
      },
    );

    expect(result.settings.slack).toEqual({
      accounts: { east: { teamId: "Teast", locale: "en" } },
    });
  });

  it("recursively splits nested accounts under an account record", () => {
    const result = projectConnectorSettings(
      {},
      {
        slack: {
          accounts: {
            parent: {
              teamId: "Tparent",
              botToken: "parent-bot",
              accounts: {
                child: { botToken: "child-bot", channel: "Cchild" },
              },
            },
          },
        },
      },
    );

    expect(result.settings.slack).toEqual({
      accounts: {
        parent: {
          teamId: "Tparent",
          accounts: { child: { channel: "Cchild" } },
        },
      },
    });
    expect(result.secrets).toEqual({
      [accountSecret("parent", "botToken")]: "parent-bot",
    });
    expect(result.secrets[accountSecret("child", "botToken")]).toBeUndefined();
  });

  it("does not project a slack object that contains a non-JSON value", () => {
    const settings = {
      slack: { enabled: true, bad: Number.NaN },
    };

    expect(projectConnectorSettings(settings, {})).toEqual({
      settings,
      secrets: {},
    });
    expect(
      projectConnectorSettings(
        {},
        { slack: { enabled: true, bad: Number.POSITIVE_INFINITY } },
      ),
    ).toEqual({ settings: {}, secrets: {} });
  });

  it("projects slack from settings alone when connectors have no slack object", () => {
    const result = projectConnectorSettings(
      {
        slack: { enabled: true, botToken: "settings-bot" },
      },
      { discord: { token: "ignored" } },
    );

    expect(result.settings.slack).toEqual({ enabled: true });
    expect(result.secrets).toEqual({
      [baseSecret("botToken")]: "settings-bot",
    });
  });

  it("omits account vault refs and whitespace account tokens from secrets", () => {
    const ref = formatVaultRef("connectors.slack.accounts.east.botToken");
    const result = projectConnectorSettings(
      {},
      {
        slack: {
          accounts: {
            east: {
              botToken: ref,
              userToken: "  ",
              appToken: "",
              teamId: "Teast",
            },
          },
        },
      },
    );

    expect(result.settings.slack).toEqual({
      accounts: { east: { teamId: "Teast" } },
    });
    expect(result.secrets).toEqual({});
  });
});
