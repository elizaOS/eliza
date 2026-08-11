/**
 * Real-PGlite proof for the Worker-owned browser pairing claim. The service,
 * repository locks, credential lookup, origin aliases, and one-time consume
 * all run against the database rather than a mocked persistence boundary.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";
process.env.NODE_ENV ||= "test";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ORG_ID = "44444444-4444-4444-8444-444444444444";
const AGENT_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_AGENT_ID = "66666666-6666-4666-8666-666666666666";
const EXPECTED_ORIGIN = `https://${AGENT_ID}.elizacloud.ai`;

let dbWrite: typeof import("../../db/client").dbWrite;
let closeDb: typeof import("../../db/client").closeDatabaseConnectionsForTests | undefined;
let pairingTokenService: ReturnType<typeof import("./pairing-token").getPairingTokenService>;

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../db/client"));
  await dbWrite.execute(`
    CREATE TABLE IF NOT EXISTS agent_sandboxes (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      agent_name text,
      environment_vars jsonb NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  await dbWrite.execute(`
    CREATE TABLE IF NOT EXISTS agent_pairing_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash text NOT NULL UNIQUE,
      organization_id uuid NOT NULL,
      user_id uuid NOT NULL,
      agent_id uuid NOT NULL,
      instance_url text NOT NULL,
      expected_origin text NOT NULL,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const { getPairingTokenService } = await import("./pairing-token");
  pairingTokenService = getPairingTokenService();
}, 60_000);

afterAll(async () => {
  await closeDb?.();
});

beforeEach(async () => {
  await dbWrite.execute("DELETE FROM agent_pairing_tokens");
  await dbWrite.execute("DELETE FROM agent_sandboxes");
  await dbWrite.execute(
    `INSERT INTO agent_sandboxes (id, organization_id, agent_name, environment_vars)
     VALUES (
       '${AGENT_ID}',
       '${ORG_ID}',
       'Browser agent',
       '{"ELIZA_API_TOKEN":"  exact-browser-api-token  "}'::jsonb
     )`,
  );
});

async function mint(instanceUrl = EXPECTED_ORIGIN): Promise<string> {
  return pairingTokenService.generateToken(USER_ID, ORG_ID, AGENT_ID, instanceUrl);
}

const correctBinding = {
  agentId: AGENT_ID,
  expectedOrigin: EXPECTED_ORIGIN,
};

async function readOnlyRow(): Promise<Record<string, unknown>> {
  const result = await dbWrite.execute("SELECT used_at, expires_at FROM agent_pairing_tokens");
  const row = result.rows[0];
  if (!row) throw new Error("Expected one pairing-token row");
  return row as Record<string, unknown>;
}

describe("Worker-owned browser pairing token claim", () => {
  test("claims the bound token and preserves the exact nonblank API-key bytes", async () => {
    const token = await mint();

    await expect(pairingTokenService.claimBrowserToken(token, correctBinding)).resolves.toEqual({
      status: "claimed",
      apiKey: "  exact-browser-api-token  ",
      agentName: "Browser agent",
      pairingToken: expect.objectContaining({
        userId: USER_ID,
        orgId: ORG_ID,
        agentId: AGENT_ID,
        expectedOrigin: EXPECTED_ORIGIN,
      }),
    });
    expect((await readOnlyRow()).used_at).not.toBeNull();
  });

  test("honors a production domain alias without weakening the agent binding", async () => {
    const mintedOrigin = `https://${AGENT_ID}.waifu.fun`;
    const token = await mint(mintedOrigin);

    await expect(
      pairingTokenService.claimBrowserToken(token, correctBinding),
    ).resolves.toMatchObject({
      status: "claimed",
      pairingToken: {
        agentId: AGENT_ID,
        expectedOrigin: mintedOrigin,
      },
    });
  });

  test("rejects the wrong URL-selected agent or origin without consuming the token", async () => {
    const token = await mint();
    const mismatches = [
      { ...correctBinding, agentId: OTHER_AGENT_ID },
      { ...correctBinding, expectedOrigin: `https://${OTHER_AGENT_ID}.elizacloud.ai` },
      { ...correctBinding, expectedOrigin: "https://unrelated.example.com" },
    ];

    for (const binding of mismatches) {
      await expect(pairingTokenService.claimBrowserToken(token, binding)).resolves.toEqual({
        status: "invalid",
      });
      expect(await readOnlyRow()).toMatchObject({ used_at: null });
    }

    await expect(
      pairingTokenService.claimBrowserToken(token, correctBinding),
    ).resolves.toMatchObject({ status: "claimed" });
  });

  test("rejects a sandbox moved to another organization without burning the token", async () => {
    const token = await mint();
    await dbWrite.execute(
      `UPDATE agent_sandboxes
       SET organization_id = '${OTHER_ORG_ID}'
       WHERE id = '${AGENT_ID}'`,
    );

    await expect(pairingTokenService.claimBrowserToken(token, correctBinding)).resolves.toEqual({
      status: "invalid",
    });
    expect(await readOnlyRow()).toMatchObject({ used_at: null });

    await dbWrite.execute(
      `UPDATE agent_sandboxes
       SET organization_id = '${ORG_ID}'
       WHERE id = '${AGENT_ID}'`,
    );
    await expect(
      pairingTokenService.claimBrowserToken(token, correctBinding),
    ).resolves.toMatchObject({ status: "claimed" });
  });

  test("distinguishes an unavailable credential and leaves the token retryable", async () => {
    const token = await mint();
    await dbWrite.execute(
      `UPDATE agent_sandboxes
       SET environment_vars = '{"ELIZA_API_TOKEN":"   "}'::jsonb
       WHERE id = '${AGENT_ID}'`,
    );

    await expect(pairingTokenService.claimBrowserToken(token, correctBinding)).resolves.toEqual({
      status: "sandbox-credential-unavailable",
    });
    expect(await readOnlyRow()).toMatchObject({ used_at: null });

    await dbWrite.execute(
      `UPDATE agent_sandboxes
       SET environment_vars = '{"ELIZA_API_TOKEN":"rotated-browser-api-token"}'::jsonb
       WHERE id = '${AGENT_ID}'`,
    );
    await expect(
      pairingTokenService.claimBrowserToken(token, correctBinding),
    ).resolves.toMatchObject({
      status: "claimed",
      apiKey: "rotated-browser-api-token",
    });
  });

  test("rejects malformed origins and expired tokens without marking them used", async () => {
    await expect(
      pairingTokenService.claimBrowserToken("malformed", {
        ...correctBinding,
        expectedOrigin: "javascript:alert(1)",
      }),
    ).resolves.toEqual({ status: "invalid" });

    const token = await mint();
    await dbWrite.execute(
      "UPDATE agent_pairing_tokens SET expires_at = now() - interval '1 second'",
    );

    await expect(pairingTokenService.claimBrowserToken(token, correctBinding)).resolves.toEqual({
      status: "invalid",
    });
    expect(await readOnlyRow()).toMatchObject({ used_at: null });
  });

  test("a successful claim is single-use", async () => {
    const token = await mint();

    await expect(
      pairingTokenService.claimBrowserToken(token, correctBinding),
    ).resolves.toMatchObject({ status: "claimed" });
    await expect(pairingTokenService.claimBrowserToken(token, correctBinding)).resolves.toEqual({
      status: "invalid",
    });
  });

  test("two concurrent valid claims have exactly one winner", async () => {
    const token = await mint();

    const results = await Promise.all([
      pairingTokenService.claimBrowserToken(token, correctBinding),
      pairingTokenService.claimBrowserToken(token, correctBinding),
    ]);

    expect(results.filter((result) => result.status === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "invalid")).toHaveLength(1);
  });
});
