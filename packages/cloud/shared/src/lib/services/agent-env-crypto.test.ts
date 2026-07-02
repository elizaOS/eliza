/**
 * At-rest encryption of `agent_sandboxes.environment_vars` (#11332).
 *
 * The bug: `updateAgentEnvironment` persisted PATCHed BYO provider keys
 * (ANTHROPIC_API_KEY / OPENAI_API_KEY / ...) verbatim into the plaintext jsonb
 * column, so user secrets sat unencrypted at rest. The first suite's at-rest
 * assertions FAIL against that pre-fix write path (negative control) and pass
 * after it: the value handed to the repository is an `enc:v1:` envelope, not
 * the secret.
 *
 * The crypto is the REAL FieldEncryptionService (AES-256-GCM, org DEK wrapped
 * by SECRETS_MASTER_KEY) — only its org-key persistence (the db helpers) is
 * swapped for an in-memory store, exactly the boundary the sibling service
 * tests already mock. The repository row store is `spyOn`-captured so the test
 * asserts the exact bytes that would land in Postgres.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";

import * as realHelpersNs from "../../db/helpers";
import type { AgentSandbox } from "../../db/repositories/agent-sandboxes";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";

// ---- in-memory organization_encryption_keys store for FieldEncryptionService ----
interface OrgKeyRow {
  id: string;
  organization_id: string;
  encrypted_dek: string;
  key_version: number;
  created_at: Date;
  rotated_at: Date | null;
}
const orgKeyRows: OrgKeyRow[] = [];

const orgKeyDb = {
  query: {
    organizationEncryptionKeys: {
      // Single-org tests: the row set has at most one entry, so the `where`
      // clause (org id / key id) always resolves to it.
      findFirst: async () => orgKeyRows[0],
    },
  },
  insert: () => ({
    values: (v: Record<string, unknown>) => ({
      onConflictDoNothing: () => ({
        returning: async () => {
          const row: OrgKeyRow = {
            id: randomUUID(),
            key_version: 1,
            created_at: new Date(),
            rotated_at: null,
            organization_id: v.organization_id as string,
            encrypted_dek: v.encrypted_dek as string,
          };
          orgKeyRows.push(row);
          return [row];
        },
      }),
    }),
  }),
};

const realHelpers = { ...realHelpersNs };
mock.module("../../db/helpers", () => ({
  ...realHelpers,
  dbRead: orgKeyDb,
  dbWrite: orgKeyDb,
}));
afterAll(() => {
  mock.module("../../db/helpers", () => realHelpers);
});

// ---- captured repository writes (the at-rest boundary) ----
const ORG_ID = "00000000-0000-4000-8000-00000000a001";
const AGENT_ID = "00000000-0000-4000-8000-00000000a002";
const SECRET = "sk-ant-api03-users-real-provider-key";

function sandboxRow(env: Record<string, string>): AgentSandbox {
  return {
    id: AGENT_ID,
    organization_id: ORG_ID,
    environment_vars: env,
    status: "running",
    execution_tier: "dedicated-lazy",
  } as unknown as AgentSandbox;
}

let storedRow: AgentSandbox;
let capturedUpdate: Record<string, unknown> | undefined;

const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockImplementation(
  async () => storedRow,
);
const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
  async (_id, data) => {
    capturedUpdate = data as Record<string, unknown>;
    storedRow = { ...storedRow, ...data } as AgentSandbox;
    return storedRow;
  },
);

const TEST_MASTER_KEY = "a".repeat(64);

beforeEach(() => {
  process.env.SECRETS_MASTER_KEY = TEST_MASTER_KEY;
  storedRow = sandboxRow({});
  capturedUpdate = undefined;
  findSpy.mockClear();
  updateSpy.mockClear();
});

afterEach(() => {
  delete process.env.SECRETS_MASTER_KEY;
});

afterAll(() => {
  findSpy.mockRestore();
  updateSpy.mockRestore();
});

async function patchEnv(env: Record<string, string>): Promise<Record<string, string>> {
  const { elizaSandboxService } = await import("./eliza-sandbox.ts?actual");
  const updated = await elizaSandboxService.updateAgentEnvironment(AGENT_ID, ORG_ID, env);
  expect(updated).toBeDefined();
  expect(capturedUpdate).toBeDefined();
  return (capturedUpdate as { environment_vars: Record<string, string> }).environment_vars;
}

describe("agent environment secrets are encrypted at rest (#11332)", () => {
  test("a PATCHed provider key is ciphertext at rest — NOT the plaintext secret", async () => {
    const stored = await patchEnv({
      ANTHROPIC_API_KEY: SECRET,
      ELIZA_PLUGIN_SET: "lean-chat",
    });

    // The at-rest bug: pre-fix these assertions fail — the row held the secret verbatim.
    expect(stored.ANTHROPIC_API_KEY).not.toBe(SECRET);
    expect(stored.ANTHROPIC_API_KEY.startsWith("enc:v1:")).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(SECRET);

    // Non-secret config stays plaintext (value-inspected by the managed-env merge).
    expect(stored.ELIZA_PLUGIN_SET).toBe("lean-chat");

    // Round-trip: materialization returns the real value to the container.
    const { decryptAgentEnvVars } = await import("./agent-env-crypto.ts?actual");
    const materialized = await decryptAgentEnvVars(stored);
    expect(materialized.ANTHROPIC_API_KEY).toBe(SECRET);
    expect(materialized.ELIZA_PLUGIN_SET).toBe("lean-chat");
  });

  test("a legacy plaintext row materializes unchanged (no backfill required)", async () => {
    const { decryptAgentEnvVars } = await import("./agent-env-crypto.ts?actual");
    const legacy = {
      OPENAI_API_KEY: "sk-legacy-plaintext-row",
      ELIZA_UI_ENABLE: "true",
    };
    expect(await decryptAgentEnvVars(legacy)).toEqual(legacy);
  });

  test("platform bridge tokens are never encrypted — control-plane sync reads stay intact", async () => {
    // The create route funnels the full managed env (incl. the platform's own
    // tokens) through updateAgentEnvironment; getAgentApiToken / the dedicated
    // proxy read these synchronously from the stored row, so they must stay
    // plaintext.
    const stored = await patchEnv({
      ELIZA_API_TOKEN: "agent_platformtoken",
      ELIZAOS_API_KEY: "legacy_alias_token",
      ELIZAOS_CLOUD_API_KEY: "cloud_platform_key",
      ANTHROPIC_API_KEY: SECRET,
    });
    expect(stored.ELIZA_API_TOKEN).toBe("agent_platformtoken");
    expect(stored.ELIZAOS_API_KEY).toBe("legacy_alias_token");
    expect(stored.ELIZAOS_CLOUD_API_KEY).toBe("cloud_platform_key");
    expect(stored.ANTHROPIC_API_KEY.startsWith("enc:v1:")).toBe(true);
  });

  test("read-modify-write PATCH echoing stored ciphertext does not double-encrypt", async () => {
    const first = await patchEnv({ OPENAI_API_KEY: "sk-first-secret" });
    const firstCiphertext = first.OPENAI_API_KEY;
    expect(firstCiphertext.startsWith("enc:v1:")).toBe(true);

    // The environment route merges { ...existing, ...patch } — stored values
    // ride back through the write path verbatim.
    const second = await patchEnv({
      OPENAI_API_KEY: firstCiphertext,
      GITHUB_TOKEN: "ghp_new_secret",
    });
    expect(second.OPENAI_API_KEY).toBe(firstCiphertext);
    expect(second.GITHUB_TOKEN.startsWith("enc:v1:")).toBe(true);

    const { decryptAgentEnvVars } = await import("./agent-env-crypto.ts?actual");
    const materialized = await decryptAgentEnvVars(second);
    expect(materialized.OPENAI_API_KEY).toBe("sk-first-secret");
    expect(materialized.GITHUB_TOKEN).toBe("ghp_new_secret");
  });

  test("without SECRETS_MASTER_KEY the write degrades to legacy plaintext (no hard dependency)", async () => {
    delete process.env.SECRETS_MASTER_KEY;
    const stored = await patchEnv({ ANTHROPIC_API_KEY: SECRET });
    expect(stored.ANTHROPIC_API_KEY).toBe(SECRET);
  });

  test("decrypt failure fails closed with the key name — never ships ciphertext as a secret", async () => {
    const { decryptAgentEnvVars } = await import("./agent-env-crypto.ts?actual");
    const stored = await patchEnv({ ANTHROPIC_API_KEY: SECRET });
    const corrupted = `${stored.ANTHROPIC_API_KEY.slice(0, -6)}AAAAAA`;
    expect(decryptAgentEnvVars({ ANTHROPIC_API_KEY: corrupted })).rejects.toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  test("sensitivity classifier: BYO secrets in, platform tokens and plain config out", async () => {
    const { isSensitiveAgentEnvKey } = await import("./agent-env-crypto.ts?actual");
    // user BYO secrets — encrypted
    expect(isSensitiveAgentEnvKey("ANTHROPIC_API_KEY")).toBe(true);
    expect(isSensitiveAgentEnvKey("OPENAI_API_KEY")).toBe(true);
    expect(isSensitiveAgentEnvKey("GITHUB_TOKEN")).toBe(true);
    expect(isSensitiveAgentEnvKey("MY_DB_PASSWORD")).toBe(true);
    expect(isSensitiveAgentEnvKey("AGENT_SERVER_SHARED_SECRET")).toBe(true);
    // platform-managed control-plane tokens — never encrypted
    expect(isSensitiveAgentEnvKey("ELIZA_API_TOKEN")).toBe(false);
    expect(isSensitiveAgentEnvKey("ELIZAOS_API_KEY")).toBe(false);
    expect(isSensitiveAgentEnvKey("ELIZAOS_CLOUD_API_KEY")).toBe(false);
    expect(isSensitiveAgentEnvKey("DATABASE_URL")).toBe(false);
    expect(isSensitiveAgentEnvKey("STEWARD_AGENT_TOKEN")).toBe(false);
    // plain config — untouched
    expect(isSensitiveAgentEnvKey("ELIZA_PLUGIN_SET")).toBe(false);
    expect(isSensitiveAgentEnvKey("ELIZA_ALLOWED_ORIGINS")).toBe(false);
    expect(isSensitiveAgentEnvKey("POSTGRES_POOL_MAX")).toBe(false);
  });
});
