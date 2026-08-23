/**
 * Unit tests for vault profile resolution and per-context routing rules.
 */

import { describe, expect, it } from "vitest";
import { ROUTING_KEY } from "./inventory.js";
import {
  type RoutingConfig,
  readRoutingConfig,
  resolveActiveValue,
  writeRoutingConfig,
} from "./profiles.js";
import type { Vault } from "./vault.js";

function makeMockVault(store: Record<string, string> = {}): Vault {
  const data = new Map<string, string>(Object.entries(store));
  return {
    async get(key: string) {
      const val = data.get(key);
      if (val === undefined) throw new Error(`key not found: ${key}`);
      return val;
    },
    async set(key: string, value: string) {
      data.set(key, value);
    },
    async has(key: string) {
      return data.has(key);
    },
    async delete(key: string) {
      data.delete(key);
    },
  } as unknown as Vault;
}

describe("vault profiles and routing", () => {
  it("reads and writes routing configuration", async () => {
    const vault = makeMockVault();
    const config: RoutingConfig = {
      rules: [
        {
          keyPattern: "OPENROUTER_API_KEY",
          scope: { kind: "agent", agentId: "agent-123" },
          profileId: "work",
        },
      ],
      defaultProfile: "personal",
    };

    await writeRoutingConfig(vault, config);
    const readBack = await readRoutingConfig(vault);

    expect(readBack).toEqual(config);
  });

  it("returns empty routing configuration on missing or invalid routing blob", async () => {
    const vaultEmpty = makeMockVault();
    expect(await readRoutingConfig(vaultEmpty)).toEqual({ rules: [] });

    const vaultInvalid = makeMockVault({
      [ROUTING_KEY]: "invalid-non-json-string",
    });
    expect(await readRoutingConfig(vaultInvalid)).toEqual({ rules: [] });
  });

  it("resolves active profile value matching agent routing rule", async () => {
    const vault = makeMockVault({
      "_meta.OPENROUTER_API_KEY": JSON.stringify({
        profiles: [{ id: "work" }, { id: "personal" }],
        activeProfile: "personal",
      }),
      "OPENROUTER_API_KEY.profile.work": "sk-or-work-key",
      "OPENROUTER_API_KEY.profile.personal": "sk-or-personal-key",
      [ROUTING_KEY]: JSON.stringify({
        rules: [
          {
            keyPattern: "OPENROUTER_API_KEY",
            scope: { kind: "agent", agentId: "agent-work" },
            profileId: "work",
          },
        ],
      }),
    });

    // Agent work rule matches
    const workVal = await resolveActiveValue(vault, "OPENROUTER_API_KEY", {
      agentId: "agent-work",
    });
    expect(workVal).toBe("sk-or-work-key");

    // Unmatched agent falls back to activeProfile (personal)
    const personalVal = await resolveActiveValue(vault, "OPENROUTER_API_KEY", {
      agentId: "agent-other",
    });
    expect(personalVal).toBe("sk-or-personal-key");
  });

  it("falls back to legacy bare key when no profiles exist", async () => {
    const vault = makeMockVault({
      OPENAI_API_KEY: "sk-openai-bare-key",
    });

    const val = await resolveActiveValue(vault, "OPENAI_API_KEY");
    expect(val).toBe("sk-openai-bare-key");
  });
});
