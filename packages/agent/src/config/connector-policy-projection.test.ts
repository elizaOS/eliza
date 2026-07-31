/**
 * EXACT-SCHEMA credential/policy boundary controls for the connector policy
 * projection.
 *
 * The blocker these regress: `buildCharacterFromConfig()` assigned the entire
 * canonical `connectors.slack` object to `character.settings.slack`. Because
 * `SlackAccountSchema` declares `botToken` / `appToken` / `userToken` /
 * `signingSecret` at BOTH the base level and inside every `accounts.<id>`
 * entry, every one of those values left `character.settings.secrets` — the only
 * boundary the runtime's redactor scans — and became an ordinary setting. The
 * assignment also shared the persisted object by reference.
 *
 * These tests are schema-driven on purpose. They enumerate the real
 * `SlackAccountSchema` / `SlackConfigSchema` shapes rather than a hand-copied
 * field list, so a credential field added to the schema tomorrow is covered by
 * these assertions the day it lands instead of silently escaping.
 */
import { describe, expect, it } from "vitest";
import { buildCharacterFromConfig } from "../runtime/build-character-config.ts";
import type { ElizaConfig } from "./config.ts";
import {
  containsCredentialKey,
  projectConnectorPolicy,
  SLACK_CREDENTIAL_FIELDS,
  SLACK_POLICY_FIELDS,
  slackAccountCredentialSettingKey,
  slackBaseCredentialSettingKey,
} from "./connector-policy-projection.ts";
import {
  SlackAccountSchema,
  SlackConfigSchema,
} from "./zod-schema.providers-core.ts";

/**
 * Unwraps optional/default/nullable wrappers to the underlying zod type name.
 * Used so the independent cross-check below is TYPE-aware: `userTokenReadOnly`
 * matches a naive /token/ name test but is a boolean policy flag that carries
 * no secret material, and misclassifying it as a credential would strip a real
 * policy field.
 */
function baseZodType(schema: unknown): string {
  let cur = schema as { _zod?: { def?: Record<string, unknown> } } | undefined;
  for (let depth = 0; depth < 12 && cur; depth += 1) {
    const def = cur._zod?.def as Record<string, unknown> | undefined;
    if (!def) break;
    const type = def.type as string | undefined;
    if (type && !["optional", "default", "nullable"].includes(type)) {
      return type;
    }
    cur = (def.innerType ?? def.schema ?? def.in) as typeof cur;
  }
  return "unknown";
}

/**
 * Every credential field, derived from the live schema INDEPENDENTLY of the
 * implementation's classifier: a string-valued field whose name denotes a
 * token or secret. Deriving it separately is the point — it cross-checks
 * `isSensitiveConfigKey` rather than restating it.
 */
const CREDENTIAL_FIELDS = Object.keys(SlackAccountSchema.shape).filter(
  (key) =>
    /token|secret/i.test(key) &&
    baseZodType((SlackAccountSchema.shape as Record<string, unknown>)[key]) ===
      "string",
);

/** Sentinel values distinguishable from any policy value. */
const SENTINELS: Record<string, string> = {
  botToken: "xoxb-CREDENTIAL-LEAK-CANARY-bot",
  appToken: "xapp-CREDENTIAL-LEAK-CANARY-app",
  userToken: "xoxp-CREDENTIAL-LEAK-CANARY-user",
  signingSecret: "CREDENTIAL-LEAK-CANARY-signing",
};

function credentialValues(prefix: string): Record<string, string> {
  return Object.fromEntries(
    CREDENTIAL_FIELDS.map((field) => [
      field,
      `${SENTINELS[field] ?? `CANARY-${field}`}-${prefix}`,
    ]),
  );
}

/** Deep scan for a literal value anywhere inside a structure. */
function containsValue(node: unknown, needle: string): boolean {
  if (typeof node === "string") return node.includes(needle);
  if (Array.isArray(node)) {
    return node.some((entry) => containsValue(entry, needle));
  }
  if (node && typeof node === "object") {
    return Object.values(node as Record<string, unknown>).some((entry) =>
      containsValue(entry, needle),
    );
  }
  return false;
}

function persistedConfig(slack: Record<string, unknown>): ElizaConfig {
  return {
    agents: { list: [{ name: "Salem", system: "house agent" }] },
    connectors: { slack },
  } as unknown as ElizaConfig;
}

describe("connector credential/policy boundary — schema derivation", () => {
  it("classifies every schema token/secret field as a credential", () => {
    // Guards the classifier itself: if `isSensitiveConfigKey` ever stopped
    // matching one of these, the strip below would silently pass it through.
    expect([...SLACK_CREDENTIAL_FIELDS].sort()).toEqual(
      [...CREDENTIAL_FIELDS].sort(),
    );
    expect(SLACK_CREDENTIAL_FIELDS).toContain("botToken");
    expect(SLACK_CREDENTIAL_FIELDS).toContain("appToken");
    expect(SLACK_CREDENTIAL_FIELDS).toContain("userToken");
    expect(SLACK_CREDENTIAL_FIELDS).toContain("signingSecret");
  });

  it("treats every remaining schema key as policy, with none misclassified", () => {
    const all = Object.keys(SlackConfigSchema.shape);
    expect([...SLACK_POLICY_FIELDS].sort()).toEqual(
      all.filter((key) => !CREDENTIAL_FIELDS.includes(key)).sort(),
    );
    // Spot-check the authorization-relevant ones the gate depends on.
    for (const key of ["channels", "dm", "groupPolicy", "requireMention"]) {
      expect(SLACK_POLICY_FIELDS).toContain(key);
    }
  });
});

describe("projectConnectorPolicy", () => {
  it("removes base AND per-account credential fields at every depth", () => {
    const projection = projectConnectorPolicy("slack", {
      ...credentialValues("base"),
      groupPolicy: "allowlist",
      channels: { C0123ABCD: { enabled: false } },
      accounts: {
        house: {
          ...credentialValues("house"),
          channels: { C0123ABCD: { requireMention: true } },
        },
        work: { ...credentialValues("work") },
      },
    });

    const policy = projection.policy as Record<string, unknown>;
    expect(policy).toBeTruthy();

    // No credential KEY survives, at any depth.
    expect(containsCredentialKey(policy)).toBe(false);
    for (const field of CREDENTIAL_FIELDS) {
      expect(field in policy).toBe(false);
      const accounts = policy.accounts as Record<
        string,
        Record<string, unknown>
      >;
      expect(field in accounts.house).toBe(false);
      expect(field in accounts.work).toBe(false);
    }

    // No credential VALUE survives either — key-shape stripping is not enough
    // if a value could be reachable under some other key.
    for (const prefix of ["base", "house", "work"]) {
      for (const value of Object.values(credentialValues(prefix))) {
        expect(containsValue(policy, value)).toBe(false);
      }
    }

    // Every policy field still reaches the plugin.
    expect(policy.groupPolicy).toBe("allowlist");
    expect(
      (policy.channels as Record<string, { enabled?: boolean }>).C0123ABCD
        .enabled,
    ).toBe(false);
    expect(
      (
        policy.accounts as Record<
          string,
          { channels: Record<string, { requireMention?: boolean }> }
        >
      ).house.channels.C0123ABCD.requireMention,
    ).toBe(true);
  });

  it("hoists base and per-account credentials onto deterministic secret keys", () => {
    const projection = projectConnectorPolicy("slack", {
      ...credentialValues("base"),
      accounts: { house: { ...credentialValues("house") } },
    });

    for (const field of CREDENTIAL_FIELDS) {
      expect(
        projection.credentialSecrets[slackBaseCredentialSettingKey(field)],
      ).toBe(credentialValues("base")[field]);
      expect(
        projection.credentialSecrets[
          slackAccountCredentialSettingKey("house", field)
        ],
      ).toBe(credentialValues("house")[field]);
    }

    // Readable, collision-free key shape.
    expect(slackAccountCredentialSettingKey("house", "botToken")).toBe(
      "SLACK_ACCOUNT_HOUSE_BOT_TOKEN",
    );
    expect(slackBaseCredentialSettingKey("signingSecret")).toBe(
      "SLACK_BASE_SIGNING_SECRET",
    );
  });

  it("shares no structure with the persisted config object", () => {
    const raw = {
      groupPolicy: "allowlist",
      channels: { C0123ABCD: { enabled: false } },
      accounts: { house: { channels: {} } },
    };
    const projection = projectConnectorPolicy("slack", raw);
    const policy = projection.policy as Record<string, unknown>;

    expect(policy).not.toBe(raw);
    expect(policy.channels).not.toBe(raw.channels);
    expect((policy.channels as Record<string, unknown>).C0123ABCD).not.toBe(
      raw.channels.C0123ABCD,
    );
    expect(policy.accounts).not.toBe(raw.accounts);

    // Mutating the projection must not write back into the loaded config.
    (
      policy.channels as Record<string, { enabled?: boolean }>
    ).C0123ABCD.enabled = true;
    expect(raw.channels.C0123ABCD.enabled).toBe(false);
  });

  it("returns no policy for an absent or non-object connector block", () => {
    expect(projectConnectorPolicy("slack", undefined).policy).toBeUndefined();
    expect(projectConnectorPolicy("slack", null).policy).toBeUndefined();
    expect(projectConnectorPolicy("slack", "nope").policy).toBeUndefined();
    expect(projectConnectorPolicy("slack", []).policy).toBeUndefined();
  });
});

describe("buildCharacterFromConfig — credential boundary (production path)", () => {
  it("never places a base or per-account credential in plain character settings", () => {
    const character = buildCharacterFromConfig(
      persistedConfig({
        ...credentialValues("base"),
        groupPolicy: "allowlist",
        channels: { C0123ABCD: { enabled: false } },
        accounts: {
          house: { ...credentialValues("house") },
          work: { ...credentialValues("work") },
        },
      }),
    );

    const settings = (character.settings ?? {}) as Record<string, unknown>;
    const { secrets: _nestedSecrets, ...plainSettings } = settings;

    // THE blocker: no credential value is reachable from plain settings.
    // Both secret sub-maps are excluded from the scan, since those are the
    // redactable locations a credential is ALLOWED to occupy.
    for (const prefix of ["base", "house", "work"]) {
      for (const value of Object.values(credentialValues(prefix))) {
        expect(containsValue(plainSettings, value)).toBe(false);
      }
    }
    expect(containsCredentialKey(settings.slack)).toBe(false);
  });

  it("still delivers every policy field to the Slack resolver's input", () => {
    const character = buildCharacterFromConfig(
      persistedConfig({
        ...credentialValues("base"),
        groupPolicy: "allowlist",
        requireMention: true,
        channels: { C0123ABCD: { enabled: false, requireMention: true } },
        dm: { policy: "allowlist", allowFrom: ["U0123ABCD"] },
        accounts: {
          house: {
            ...credentialValues("house"),
            channels: { C0999ZZZZ: { enabled: true } },
          },
        },
      }),
    );

    const slack = character.settings?.slack as Record<string, unknown>;
    expect(slack.groupPolicy).toBe("allowlist");
    expect(slack.requireMention).toBe(true);
    expect(
      (slack.channels as Record<string, { enabled?: boolean }>).C0123ABCD
        .enabled,
    ).toBe(false);
    expect((slack.dm as { policy?: string }).policy).toBe("allowlist");
    expect(
      (
        slack.accounts as Record<
          string,
          { channels: Record<string, { enabled?: boolean }> }
        >
      ).house.channels.C0999ZZZZ.enabled,
    ).toBe(true);
  });

  it("routes hoisted credentials into the redactable secrets map", () => {
    const character = buildCharacterFromConfig(
      persistedConfig({
        ...credentialValues("base"),
        accounts: { house: { ...credentialValues("house") } },
      }),
    );

    // `buildCharacterFromConfig` publishes credentials on `character.secrets`.
    // That is a genuine redaction boundary: `buildSecretSwapSession()` seeds
    // its known-secret set from `character.secrets` as well as
    // `character.settings.secrets`, and `getSetting()` consults
    // `character.secrets` FIRST — so the plugin resolves these while the value
    // never exists in plain settings.
    const secrets = (character.secrets ?? {}) as Record<string, string>;
    for (const field of CREDENTIAL_FIELDS) {
      expect(secrets[slackBaseCredentialSettingKey(field)]).toBe(
        credentialValues("base")[field],
      );
      expect(secrets[slackAccountCredentialSettingKey("house", field)]).toBe(
        credentialValues("house")[field],
      );
    }

    // And the plain-settings side stays clean for the same values.
    const plainSettings = { ...(character.settings ?? {}) } as Record<
      string,
      unknown
    >;
    delete plainSettings.secrets;
    for (const value of Object.values(secrets)) {
      expect(containsValue(plainSettings, value)).toBe(false);
    }
  });
});
