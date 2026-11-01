/** Drives the paid proxy boundary through the production dispatch client against a deterministic organization gate; no database, provider or account changes are performed. */
import { afterAll, expect, mock, test } from "bun:test";
import {
  InferenceAdmissionGateUnavailableError,
  markInferenceAdmissionLeaseDispatched,
} from "@elizaos/cloud-shared/lib/services/inference-admission-gate";
import * as admission from "@elizaos/cloud-shared/lib/services/organization-inference-admission";
import { chainDataHandler } from "@elizaos/cloud-shared/lib/services/proxy/chain-data";
import { cacheWarmingRetryDelayMs } from "../test/e2e/_helpers/api";

const alchemyKey = process.env.ALCHEMY_API_KEY;
delete process.env.ALCHEMY_API_KEY;
afterAll(() => {
  if (alchemyKey !== undefined) process.env.ALCHEMY_API_KEY = alchemyKey;
});

const real = { ...admission };
let gate: () => Promise<Response> = async () => Response.json({});
let settlements: string[] = [];
mock.module(
  "@elizaos/cloud-shared/lib/services/organization-inference-admission",
  () => ({
    ...real,
    admitOrganizationInference: async () => {
      const lease = {
        organizationId: "org-a",
        requestId: "request-a",
        estimatedCostUsd: 0.001,
        providerDispatched: false,
        preProviderCancellationToken: "capability-a",
        gate: { fetch: () => gate() } as never,
        preparedDispatch: {
          path: "/lease-dispatched" as const,
          state: "prepared" as const,
          body: { organizationId: "org-a", requestId: "request-a" },
        },
      };
      return {
        mode: "durable_object_debit",
        settle: async (usd: number) => {
          settlements.push(`settle:${usd}`);
          return null;
        },
        settleUnknown: async () => {
          settlements.push("unknown");
          return null;
        },
        // The same wrapping attachInferenceAdmissionLease applies in production.
        markProviderDispatched: async () => {
          try {
            await markInferenceAdmissionLeaseDispatched(lease);
          } catch (error) {
            if (error instanceof InferenceAdmissionGateUnavailableError) {
              throw new real.InferenceAdmissionUnavailableError({
                cause: error,
              });
            }
            throw error;
          }
        },
      };
    },
  }),
);
const { executeWithBody } = await import(
  "@elizaos/cloud-shared/lib/services/proxy/engine"
);

const cold = () =>
  Response.json(
    {
      success: false,
      code: "inference_admission_gate_uninitialized",
      error: "Inference admission gate is warming",
    },
    { status: 503 },
  );
const ack = () =>
  Response.json({
    admitted: true,
    dispatched: true,
    availableUsd: 9,
    requiredUsd: 0.001,
  });

let providerCalls = 0;
async function getNfts(): Promise<Response> {
  settlements = [];
  providerCalls = 0;
  return executeWithBody(
    {
      id: "chain-data",
      name: "Chain Data",
      auth: "apiKeyWithOrg",
      getCost: async () => 0.001,
    },
    async (context) => {
      providerCalls++;
      return chainDataHandler(context);
    },
    new Request(
      `https://api.test/api/v1/chain/nfts/ethereum/0x${"0".repeat(40)}`,
    ),
    {
      method: "getNFTsForOwner",
      chain: "ethereum",
      params: { owner: `0x${"0".repeat(40)}` },
    },
    {
      mode: "combined",
      auth: { user: { id: "user-a", organization_id: "org-a" } },
      requestId: "request-a",
      admissionSnapshot: {} as never,
      executionCtx: { waitUntil: () => {} },
    },
  );
}

test("a cold organization gate answers a typed refusal the E2E helper replays", async () => {
  gate = async () => cold();
  const refused = await getNfts();
  expect(refused.status).toBe(503);
  expect(((await refused.clone().json()) as { code: string }).code).toBe(
    "inference_admission_cache_warming",
  );
  expect(await cacheWarmingRetryDelayMs(refused)).toBe(1000);
  expect(providerCalls).toBe(0);
  expect(settlements).toEqual(["settle:0"]);

  gate = async () => ack();
  const replayed = await getNfts();
  expect(replayed.status).toBe(502);
  expect(providerCalls).toBe(1);
});

test("a cold answer after a possibly committed dispatch stays a generic refusal", async () => {
  let calls = 0;
  gate = async () => {
    if (++calls === 1) throw new Error("Network connection lost.");
    return cold();
  };
  const refused = await getNfts();
  expect(refused.status).toBe(503);
  expect(((await refused.clone().json()) as { code: string }).code).toBe(
    "service_unavailable",
  );
  expect(await cacheWarmingRetryDelayMs(refused)).toBeNull();
  expect(providerCalls).toBe(0);
  expect(settlements).toEqual(["settle:0"]);
});
