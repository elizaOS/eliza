/**
 * Real-PGlite proof for the authenticated native pairing claim.
 *
 * The service, repository, Drizzle UPDATE, hashing, expiry, and database are
 * real. A mismatch in any authenticated binding must leave the token usable by
 * its rightful owner, while concurrent valid claims still yield one winner.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";
process.env.NODE_ENV ||= "test";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
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
      organization_id uuid NOT NULL
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
    `INSERT INTO agent_sandboxes (id, organization_id)
     VALUES ('${AGENT_ID}', '${ORG_ID}')`,
  );
});

async function mint(instanceUrl = EXPECTED_ORIGIN): Promise<string> {
  return pairingTokenService.generateToken(USER_ID, ORG_ID, AGENT_ID, instanceUrl);
}

const correctBinding = {
  userId: USER_ID,
  orgId: ORG_ID,
  agentId: AGENT_ID,
  expectedOrigin: EXPECTED_ORIGIN,
};

async function readOnlyRow(): Promise<Record<string, unknown>> {
  const result = await dbWrite.execute("SELECT used_at, expires_at FROM agent_pairing_tokens");
  const row = result.rows[0];
  if (!row) throw new Error("Expected one pairing-token row");
  return row as Record<string, unknown>;
}

describe("authenticated native pairing token claim", () => {
  test("preserves browser alias-origin compatibility on the public validator", async () => {
    const token = await mint(`https://${AGENT_ID}.waifu.fun`);

    await expect(pairingTokenService.validateToken(token, EXPECTED_ORIGIN)).resolves.toMatchObject({
      agentId: AGENT_ID,
      expectedOrigin: `https://${AGENT_ID}.waifu.fun`,
    });
  });

  test("every wrong identity binding fails without consuming the token", async () => {
    const token = await mint();
    const mismatches = [
      { ...correctBinding, userId: OTHER_USER_ID },
      { ...correctBinding, orgId: OTHER_ORG_ID },
      { ...correctBinding, agentId: OTHER_AGENT_ID },
      {
        ...correctBinding,
        expectedOrigin: "https://wrong-agent.elizacloud.ai",
      },
    ];

    for (const binding of mismatches) {
      await expect(
        pairingTokenService.validateAuthenticatedNativeToken(token, binding),
      ).resolves.toBeNull();
      expect(await readOnlyRow()).toMatchObject({ used_at: null });
    }

    await expect(
      pairingTokenService.validateAuthenticatedNativeToken(token, correctBinding),
    ).resolves.toMatchObject({
      userId: USER_ID,
      orgId: ORG_ID,
      agentId: AGENT_ID,
      expectedOrigin: EXPECTED_ORIGIN,
    });
    expect((await readOnlyRow()).used_at).not.toBeNull();
  });

  test("a transferred sandbox fails the atomic ownership check without burning the token", async () => {
    const token = await mint();
    await dbWrite.execute(
      `UPDATE agent_sandboxes
       SET organization_id = '${OTHER_ORG_ID}'
       WHERE id = '${AGENT_ID}'`,
    );

    await expect(
      pairingTokenService.validateAuthenticatedNativeToken(token, correctBinding),
    ).resolves.toBeNull();
    expect(await readOnlyRow()).toMatchObject({ used_at: null });

    await dbWrite.execute(
      `UPDATE agent_sandboxes
       SET organization_id = '${ORG_ID}'
       WHERE id = '${AGENT_ID}'`,
    );
    await expect(
      pairingTokenService.validateAuthenticatedNativeToken(token, correctBinding),
    ).resolves.toMatchObject({ agentId: AGENT_ID });
  });

  test("rejects malformed and expired candidates without marking them used", async () => {
    await expect(
      pairingTokenService.validateAuthenticatedNativeToken("malformed", {
        ...correctBinding,
        expectedOrigin: "javascript:alert(1)",
      }),
    ).resolves.toBeNull();

    const token = await mint();
    await dbWrite.execute(
      "UPDATE agent_pairing_tokens SET expires_at = now() - interval '1 second'",
    );

    await expect(
      pairingTokenService.validateAuthenticatedNativeToken(token, correctBinding),
    ).resolves.toBeNull();
    expect(await readOnlyRow()).toMatchObject({ used_at: null });
  });

  test("a successful claim is single-use", async () => {
    const token = await mint();

    const first = await pairingTokenService.validateAuthenticatedNativeToken(token, correctBinding);
    const replay = await pairingTokenService.validateAuthenticatedNativeToken(
      token,
      correctBinding,
    );

    expect(first).toMatchObject({ agentId: AGENT_ID });
    expect(replay).toBeNull();
  });

  test("two concurrent valid claims have exactly one winner", async () => {
    const token = await mint();

    const results = await Promise.all([
      pairingTokenService.validateAuthenticatedNativeToken(token, correctBinding),
      pairingTokenService.validateAuthenticatedNativeToken(token, correctBinding),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
  });
});
