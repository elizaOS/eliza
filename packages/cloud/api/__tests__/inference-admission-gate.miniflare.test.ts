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
      compatibilityDate: "2026-06-01",
      compatibilityFlags: ["nodejs_compat"],
      modules: true,
      script: await output.text(),
      durableObjects: {
        TEST_ADMISSION_GATE: {
          className: "InferenceAdmissionGate",
          useSQLite: true,
        },
      },
    });
  });

  afterAll(async () => {
    await miniflare?.dispose();
  });

  async function post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ readonly status: number; text(): Promise<string> }> {
    const response = await miniflare.dispatchFetch(`https://gate.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-organization-id": "org-miniflare",
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      text: async () => await response.text(),
    };
  }

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
  }, 30_000);
});
