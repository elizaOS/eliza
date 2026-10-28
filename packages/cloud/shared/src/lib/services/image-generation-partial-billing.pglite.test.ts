/**
 * A multi-image request that fails partway bills only the images sent to the
 * provider. Real image executor and creditsService reservation/reconcile on
 * PGlite, admitted like the synchronous lane of admitFlatGenerativeOperation
 * (settleUnknown settles the full estimate). Only the provider and R2 are fakes.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { installOrganizationPolicyTestSchema } from "../../db/repositories/organization-policy-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG = "00000000-0000-4000-8000-0000000a1111";
const PER_IMAGE = 0.05;
let client: typeof import("../../db/client");

const objects = new Map<string, number>();
const bindings = {
  BLOB: {
    put: async (key: string, body: ArrayBufferView) => void objects.set(key, body.byteLength),
    delete: async (key: string) => void objects.delete(key),
  },
  R2_PUBLIC_HOST: "blob.example",
} as never;

beforeAll(async () => {
  client = await import("../../db/client");
  const pg = client.getPgliteClientForTests();
  await pg.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY, name text, slug text, updated_at timestamptz DEFAULT now());
    CREATE TABLE credit_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
      user_id uuid, amount numeric(16,6) NOT NULL, type text NOT NULL, description text,
      metadata jsonb NOT NULL DEFAULT '{}', stripe_payment_intent_id text UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz);
  `);
  await installOrganizationPolicyTestSchema((q) => pg.exec(q));
  await pg.exec(`INSERT INTO organizations (id, name, slug, credit_balance) VALUES ('${ORG}', 'o', 'o', 10);
                 INSERT INTO org_storage_quota (organization_id) VALUES ('${ORG}');`);
}, 60_000);

afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
});

test("a 4-image request that fails on image 2 bills the 2 images sent to the provider", async () => {
  const { creditsService } = await import("./credits");
  const { orgStorageQuotaRepository: quota } = await import(
    "../../db/repositories/org-storage-quota"
  );
  const { putPublicObject } = await import("../storage/r2-public-object");
  const { createImageGenerationExecutor } = await import("./image-generation");
  const { DEFAULT_IMAGE_MODEL_ID } = await import("./ai-pricing-definitions");

  let providerCalls = 0;
  let seq = 0;
  const execute = createImageGenerationExecutor({
    getProvider: () =>
      ({
        billingSource: "fal",
        generate: async () => {
          providerCalls += 1;
          if (providerCalls === 2) throw new Error("upstream 502");
          return {
            dataUrl: "data:image/png;base64,AA==",
            bytes: new Uint8Array(10),
            mimeType: "image/png",
            text: "",
          };
        },
      }) as never,
    calculateCost: async (input) => ({ totalCost: PER_IMAGE * (input.imageCount ?? 1) }) as never,
    assertSafe: async () => undefined,
    putObject: putPublicObject,
    storageQuota: quota,
    createGeneration: async () => ({ id: `g-${++seq}` }),
    deleteGeneration: async () => undefined,
    billFlat: async () => undefined,
    randomUuid: () => `uuid-${++seq}`,
    now: () => new Date(),
  });

  const error = await execute({
    input: { prompt: "a lighthouse", model: DEFAULT_IMAGE_MODEL_ID, numImages: 4 },
    actor: { organizationId: ORG, userId: "00000000-0000-4000-8000-0000000a2222", apiKeyId: null },
    identity: { requestId: "req-1", source: "http" },
    bindings,
    providerKeys: { FAL_KEY: "fal", ATLASCLOUD_API_KEY: "atlas" },
    admit: async ({ cost }) => {
      const reservation = await creditsService.reserve({
        organizationId: ORG,
        userId: "00000000-0000-4000-8000-0000000a2222",
        amount: cost.totalCost,
        description: "Image generation",
      });
      const settle = async (actual: number) => (await reservation.reconcile(actual)) ?? null;
      return {
        kind: "organization" as const,
        admission: { reservation, settle, settleUnknown: () => settle(cost.totalCost) },
      };
    },
  }).catch((e) => e);

  const pg = client.getPgliteClientForTests();
  const balance = (
    await pg.query<{ b: string }>(
      `SELECT credit_balance::text b FROM organizations WHERE id='${ORG}'`,
    )
  ).rows[0].b;
  expect((error as { status?: number }).status).toBe(503);
  expect(providerCalls).toBe(2);
  expect(Number(balance)).toBeCloseTo(10 - 2 * PER_IMAGE, 6);
}, 30_000);
