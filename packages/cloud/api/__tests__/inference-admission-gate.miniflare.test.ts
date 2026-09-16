/**
 * Runs the production admission class inside Miniflare to prove Cloudflare's
 * real Durable Object storage and request serialization preserve spend holds.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const ADMISSION_RUNTIME_BOUNDARY_FILTERS = {
  dbClient:
    /(?:^|[\\/])packages[\\/]cloud[\\/]shared[\\/]src[\\/]db[\\/]client\.ts$/,
  cloudBindings:
    /(?:^|[\\/])packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]runtime[\\/]cloud-bindings\.ts$/,
  admissionRecovery:
    /(?:^|[\\/])packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]services[\\/]inference-admission-recovery\.ts$/,
  logger:
    /(?:^|[\\/])packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]utils[\\/]logger\.ts$/,
} as const;

const ADMISSION_RUNTIME_BOUNDARY_PATHS = [
  {
    name: "database client",
    filter: ADMISSION_RUNTIME_BOUNDARY_FILTERS.dbClient,
    relative: "packages/cloud/shared/src/db/client.ts",
  },
  {
    name: "cloud bindings",
    filter: ADMISSION_RUNTIME_BOUNDARY_FILTERS.cloudBindings,
    relative: "packages/cloud/shared/src/lib/runtime/cloud-bindings.ts",
  },
  {
    name: "admission recovery",
    filter: ADMISSION_RUNTIME_BOUNDARY_FILTERS.admissionRecovery,
    relative:
      "packages/cloud/shared/src/lib/services/inference-admission-recovery.ts",
  },
  {
    name: "logger",
    filter: ADMISSION_RUNTIME_BOUNDARY_FILTERS.logger,
    relative: "packages/cloud/shared/src/lib/utils/logger.ts",
  },
] as const;

for (const { name, filter, relative } of ADMISSION_RUNTIME_BOUNDARY_PATHS) {
  test(`build filter matches the ${name} on POSIX and Windows only`, () => {
    expect(filter.test(`/work/eliza/${relative}`)).toBe(true);
    expect(
      filter.test(`D:\\work\\eliza\\${relative.replaceAll("/", "\\")}`),
    ).toBe(true);
    expect(filter.test(`/work/eliza-fork/${relative}.backup`)).toBe(false);
    expect(
      filter.test(
        `/work/eliza/${relative.replace("/shared/", "/shared-sibling/")}`,
      ),
    ).toBe(false);
  });
}

describe("Miniflare Durable Object integration", () => {
  let miniflare: Miniflare;

  beforeAll(async () => {
    const build = await Bun.build({
      entrypoints: [
        fileURLToPath(
          new URL(
            "../test/fixtures/inference-admission-gate-worker.ts",
            import.meta.url,
          ),
        ),
      ],
      format: "esm",
      target: "browser",
      conditions: ["worker", "browser"],
      plugins: [
        {
          name: "admission-runtime-boundaries",
          setup(build) {
            build.onLoad(
              { filter: ADMISSION_RUNTIME_BOUNDARY_FILTERS.dbClient },
              () => ({
                loader: "ts",
                contents: `
              export async function runWithDbCacheAsync<T>(operation: () => Promise<T>): Promise<T> {
                return await operation();
              }
            `,
              }),
            );
            build.onLoad(
              {
                filter: ADMISSION_RUNTIME_BOUNDARY_FILTERS.cloudBindings,
              },
              () => ({
                loader: "ts",
                contents: `
                export async function runWithCloudBindingsAsync<T>(
                  _bindings: Record<string, unknown>,
                  operation: () => Promise<T>,
                ): Promise<T> {
                  return await operation();
                }
              `,
              }),
            );
            build.onLoad(
              {
                filter: ADMISSION_RUNTIME_BOUNDARY_FILTERS.admissionRecovery,
              },
              () => ({
                loader: "ts",
                contents: `
                export async function recoverExpiredInferenceAdmissionLease(): Promise<never> {
                  throw new Error("alarm recovery is outside this serialization test");
                }
              `,
              }),
            );
            build.onLoad(
              { filter: ADMISSION_RUNTIME_BOUNDARY_FILTERS.logger },
              () => ({
                loader: "ts",
                contents: `
                export const logger = {
                  debug() {},
                  info() {},
                  warn() {},
                  error() {},
                };
              `,
              }),
            );
          },
        },
      ],
    });
    if (!build.success) {
      throw new AggregateError(
        build.logs,
        "Failed to bundle admission test Worker",
      );
    }
    const output = build.outputs[0];
    if (!output)
      throw new Error("Admission test Worker bundle was not emitted");

    miniflare = new Miniflare({
      // Match the deployed API Worker so synchronous SQLite KV is exercised
      // under the exact production compatibility contract.
      compatibilityDate: "2026-04-01",
      compatibilityFlags: ["nodejs_compat"],
      modules: true,
      script: await output.text(),
      durableObjects: {
        INFERENCE_ADMISSION_GATES: {
          className: "TestInferenceAdmissionGate",
          useSQLite: true,
        },
      },
      kvNamespaces: ["TEST_AUTH_CACHE"],
    });
  });

  afterAll(async () => {
    await miniflare?.dispose();
  });

  async function post(
    path: string,
    body: Record<string, unknown>,
    gateName = "org-miniflare",
  ): Promise<{ readonly status: number; text(): Promise<string> }> {
    const response = await miniflare.dispatchFetch(`https://gate.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-organization-id": "org-miniflare",
        "x-test-gate-name": gateName,
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      text: async () => await response.text(),
    };
  }

  // Match the cloud test lane's budget because Miniflare startup can be delayed
  // when this integration test runs alongside the rest of the batched suite.
  test("real Durable Object serialization prevents concurrent overspend", async () => {
    expect(
      (
        await post("/hydrate", {
          balanceUsd: 10,
          balanceAt: Date.now(),
          balanceRevision: "1",
        })
      ).status,
    ).toBe(200);

    const [first, second] = await Promise.all([
      post("/lease", {
        organizationId: "org-miniflare",
        requestId: "request-a",
        balanceUsd: 10,
        balanceRevision: "1",
        estimatedCostUsd: 7,
        recovery: {
          version: 1,
          kind: "organization",
          organizationId: "org-miniflare",
          userId: "00000000-0000-0000-0000-000000000002",
          requestId: "request-a",
          model: "test-model",
          provider: "test-provider",
          billingSource: "test",
          description: "Miniflare admission test",
          accounting: { kind: "direct_debit" },
        },
      }),
      post("/lease", {
        organizationId: "org-miniflare",
        requestId: "request-b",
        balanceUsd: 10,
        balanceRevision: "1",
        estimatedCostUsd: 7,
        recovery: {
          version: 1,
          kind: "organization",
          organizationId: "org-miniflare",
          userId: "00000000-0000-0000-0000-000000000002",
          requestId: "request-b",
          model: "test-model",
          provider: "test-provider",
          billingSource: "test",
          description: "Miniflare admission test",
          accounting: { kind: "direct_debit" },
        },
      }),
    ]);

    if (first.status === 400 || second.status === 400) {
      throw new Error(
        `Unexpected gate validation response: ${first.status} ${await first.text()} / ${second.status} ${await second.text()}`,
      );
    }
    expect([first.status, second.status].sort()).toEqual([200, 402]);
  }, 120_000);

  test("credential checks bypass a blocked billing queue on the same object", async () => {
    expect((await post("/test-block-billing-queue", {})).status).toBe(202);
    const credentialCheck = await Promise.race([
      post("/credential/check", {
        organizationId: "org-miniflare",
        kind: "api_key",
        credentialId: "00000000-0000-0000-0000-000000000104",
        userId: "00000000-0000-0000-0000-000000000204",
      }),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("credential check waited behind billing")),
          500,
        );
      }),
    ]);
    expect(credentialCheck.status).toBe(200);
    expect((await post("/test-release-billing-queue", {})).status).toBe(204);
  });

  test("the revocation queue preserves read-write ordering", async () => {
    const response = await post("/test-revocation-queue-order", {});
    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text())).toEqual({
      order: ["first:start", "first:end", "second"],
    });
  });

  test("independent callers observe API-key revocation immediately", async () => {
    const credential = {
      organizationId: "org-miniflare",
      kind: "api_key",
      credentialId: "00000000-0000-0000-0000-000000000101",
      userId: "00000000-0000-0000-0000-000000000201",
    };
    const staleCache = await miniflare.getKVNamespace("TEST_AUTH_CACHE");
    const staleCacheKey = "inference-auth:test-stale-positive";
    const stalePositive = JSON.stringify({
      kind: "authorized",
      apiKeyId: credential.credentialId,
      userId: credential.userId,
      organizationId: credential.organizationId,
    });
    await staleCache.put(staleCacheKey, stalePositive);
    expect((await post("/credential/check", credential)).status).toBe(200);
    expect(
      (
        await post("/credential/revoke", {
          organizationId: credential.organizationId,
          kind: credential.kind,
          credentialId: credential.credentialId,
        })
      ).status,
    ).toBe(200);

    // This second dispatch models another Worker location retaining a stale
    // positive KV entry. Deliberately leave the real workerd KV value untouched
    // to model delayed delete visibility: the shared DO remains authoritative.
    expect((await staleCache.get(staleCacheKey)) as string | null).toBe(
      stalePositive,
    );
    expect((await post("/credential/check", credential)).status).toBe(403);
    expect((await staleCache.get(staleCacheKey)) as string | null).toBe(
      stalePositive,
    );
  });

  test("authorized lease checks revocation and balance in one Durable Object request", async () => {
    const organizationId = "org-miniflare-authorized-lease";
    const credential = {
      organizationId,
      kind: "api_key",
      credentialId: "00000000-0000-0000-0000-000000000106",
      userId: "00000000-0000-0000-0000-000000000206",
    };
    expect(
      (
        await post(
          "/hydrate",
          { balanceUsd: 1, balanceRevision: "1" },
          organizationId,
        )
      ).status,
    ).toBe(200);
    const leaseBody = (requestId: string) => ({
      organizationId,
      requestId,
      balanceUsd: 1,
      balanceRevision: "1",
      estimatedCostUsd: 1,
      credential,
      recovery: {
        version: 1,
        kind: "organization",
        organizationId,
        userId: credential.userId,
        requestId,
        model: "test-model",
        provider: "test-provider",
        billingSource: "test",
        description: "authorized Miniflare admission test",
        accounting: { kind: "direct_debit" },
      },
    });
    expect(
      (
        await post(
          "/lease-authorized",
          leaseBody("authorized-before-revocation"),
          organizationId,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post(
          "/credential/revoke",
          {
            organizationId,
            kind: credential.kind,
            credentialId: credential.credentialId,
          },
          organizationId,
        )
      ).status,
    ).toBe(200);
    const denied = await post(
      "/lease-authorized",
      leaseBody("authorized-after-revocation"),
      organizationId,
    );
    expect(denied.status).toBe(403);
    expect(JSON.parse(await denied.text())).toEqual({
      allowed: false,
      reason: "credential_revoked",
    });
  });

  test("session cutoff revokes old tokens without rejecting a later login", async () => {
    const base = {
      organizationId: "org-miniflare",
      kind: "steward_session",
      userId: "00000000-0000-0000-0000-000000000202",
      stewardUserId: "steward-user-202",
    };
    expect(
      (
        await post("/session/revoke-through", {
          organizationId: base.organizationId,
          userId: base.userId,
          issuedAt: 100,
        })
      ).status,
    ).toBe(200);
    expect(
      (await post("/credential/check", { ...base, issuedAt: 100 })).status,
    ).toBe(403);
    expect(
      (await post("/credential/check", { ...base, issuedAt: 101 })).status,
    ).toBe(200);
  });

  test("revoked session bindings reject new tokens using a stale user mapping", async () => {
    const credential = {
      organizationId: "org-miniflare-session-binding",
      kind: "steward_session",
      userId: "00000000-0000-0000-0000-000000000205",
      stewardUserId: "steward-user-unlinked",
      issuedAt: 201,
    };
    expect((await post("/credential/check", credential)).status).toBe(200);
    expect(
      (
        await post("/session/set-binding-active", {
          organizationId: credential.organizationId,
          userId: credential.userId,
          stewardUserId: credential.stewardUserId,
          active: false,
        })
      ).status,
    ).toBe(200);
    const denied = await post("/credential/check", {
      ...credential,
      issuedAt: credential.issuedAt + 1,
    });
    expect(denied.status).toBe(403);
    expect(JSON.parse(await denied.text())).toEqual({
      allowed: false,
      reason: "session_binding_revoked",
    });
    await post("/session/set-binding-active", {
      organizationId: credential.organizationId,
      userId: credential.userId,
      stewardUserId: credential.stewardUserId,
      active: true,
    });
    expect((await post("/credential/check", credential)).status).toBe(200);
  });

  test("subject and organization suspension are reversible durable fences", async () => {
    const credential = {
      organizationId: "org-miniflare",
      kind: "api_key",
      credentialId: "00000000-0000-0000-0000-000000000102",
      userId: "00000000-0000-0000-0000-000000000203",
    };
    expect(
      (
        await post("/subject/set-active", {
          organizationId: credential.organizationId,
          userId: credential.userId,
          active: false,
          reason: "account",
        })
      ).status,
    ).toBe(200);
    expect((await post("/credential/check", credential)).status).toBe(403);
    await post("/subject/set-active", {
      organizationId: credential.organizationId,
      userId: credential.userId,
      active: true,
      reason: "account",
    });
    expect((await post("/credential/check", credential)).status).toBe(200);

    await post("/organization/set-active", {
      organizationId: credential.organizationId,
      active: false,
    });
    expect((await post("/credential/check", credential)).status).toBe(403);
    await post("/organization/set-active", {
      organizationId: credential.organizationId,
      active: true,
    });
    expect((await post("/credential/check", credential)).status).toBe(200);
  });

  test("a separate rate-limit identity answers without duplicating a window across cutover", async () => {
    const windowMs = 1_000;
    const legacyWindowStartedAt = Math.floor(Date.now() / windowMs) * windowMs;
    const policy = {
      endpointType: "completions",
      windowMs,
      maxRequests: 1,
      windowStartedAt: legacyWindowStartedAt,
    };
    expect((await post("/rate-limit", policy)).status).toBe(200);
    expect((await post("/test-block-ledger", {})).status).toBe(202);

    const blockedLegacy = post("/rate-limit", policy);
    const legacyAnsweredEarly = await Promise.race([
      blockedLegacy.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 300)),
    ]);
    expect(legacyAnsweredEarly).toBe(false);

    const cutoverDelay = Math.max(
      0,
      legacyWindowStartedAt + windowMs - Date.now() + 10,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, cutoverDelay));
    const isolated = await Promise.race([
      post(
        "/rate-limit",
        {
          ...policy,
          windowStartedAt: legacyWindowStartedAt + windowMs,
        },
        "rate-limit:v2:org-miniflare",
      ),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("isolated rate limit waited behind ledger")),
          500,
        );
      }),
    ]);
    expect(isolated.status).toBe(200);
    expect((await blockedLegacy).status).toBe(429);
  }, 120_000);

  test("the cutover coordinator chooses the next exact fixed-window boundary", async () => {
    const response = await post(
      "/rate-limit-v2-cutover",
      { windowMs: 60_000 },
      "rate-limit:v2:cutover",
    );
    expect(response.status).toBe(200);
    const body = JSON.parse(await response.text()) as { cutoverAt: number };
    expect(body.cutoverAt % 60_000).toBe(0);
    expect(body.cutoverAt).toBeGreaterThan(Date.now());
    expect(body.cutoverAt - Date.now()).toBeLessThanOrEqual(60_000);
  }, 120_000);

  test("the active v2 rate-limit identity answers while the obsolete cutover coordinator is blocked", async () => {
    expect(
      (await post("/test-block-ledger", {}, "rate-limit:v2:cutover")).status,
    ).toBe(202);

    const blockedCutover = post(
      "/rate-limit-v2-cutover",
      { windowMs: 60_000 },
      "rate-limit:v2:cutover",
    );
    const cutoverAnsweredEarly = await Promise.race([
      blockedCutover.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 300)),
    ]);
    expect(cutoverAnsweredEarly).toBe(false);

    const isolated = await Promise.race([
      post(
        "/rate-limit",
        {
          endpointType: "completions",
          windowMs: 60_000,
          maxRequests: 1,
          windowStartedAt: Math.floor(Date.now() / 60_000) * 60_000,
        },
        "rate-limit:v2:org-miniflare-cutover-blocked",
      ),
      new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(
              new Error("v2 rate limit waited behind cutover coordinator"),
            ),
          500,
        );
      }),
    ]);
    expect(isolated.status).toBe(200);
    expect((await blockedCutover).status).toBe(200);
  }, 120_000);

  test("synchronous SQLite KV continues the exact async-KV quota window", async () => {
    const gateName = "rate-limit:v2:org-miniflare-sync-kv-compat";
    const windowMs = 60_000;
    const windowStartedAt = Math.floor(Date.now() / windowMs) * windowMs;
    expect(
      (
        await post(
          "/test-seed-legacy-rate-limits",
          {
            completions: {
              windowStartedAt,
              windowMs,
              maxRequests: 1,
              count: 1,
            },
          },
          gateName,
        )
      ).status,
    ).toBe(204);

    const denied = await post(
      "/rate-limit",
      {
        endpointType: "completions",
        windowMs,
        maxRequests: 1,
        windowStartedAt,
      },
      gateName,
    );
    expect(denied.status).toBe(429);

    const persisted = await post("/test-read-legacy-rate-limits", {}, gateName);
    expect(JSON.parse(await persisted.text())).toEqual({
      completions: {
        windowStartedAt,
        windowMs,
        maxRequests: 1,
        count: 2,
      },
    });
  }, 120_000);

  test("clearing one subject denial cannot clear an independent denial", async () => {
    const credential = {
      organizationId: "org-miniflare-independent-fences",
      kind: "api_key",
      credentialId: "00000000-0000-0000-0000-000000000103",
      userId: "00000000-0000-0000-0000-000000000204",
    };
    for (const reason of ["account", "moderation"]) {
      expect(
        (
          await post("/subject/set-active", {
            organizationId: credential.organizationId,
            userId: credential.userId,
            active: false,
            reason,
          })
        ).status,
      ).toBe(200);
    }

    expect((await post("/credential/check", credential)).status).toBe(403);
    expect(
      (
        await post("/subject/set-active", {
          organizationId: credential.organizationId,
          userId: credential.userId,
          active: true,
          reason: "moderation",
        })
      ).status,
    ).toBe(200);
    const stillDenied = await post("/credential/check", credential);
    expect(stillDenied.status).toBe(403);
    expect(JSON.parse(await stillDenied.text())).toEqual({
      allowed: false,
      reason: "subject_account_disabled",
    });

    await post("/subject/set-active", {
      organizationId: credential.organizationId,
      userId: credential.userId,
      active: true,
      reason: "account",
    });
    expect((await post("/credential/check", credential)).status).toBe(200);
  });
});
