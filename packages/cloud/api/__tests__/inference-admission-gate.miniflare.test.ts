/**
 * Runs the production admission class inside Miniflare to prove Cloudflare's
 * real Durable Object storage and request serialization preserve spend holds.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare } from "miniflare";

let miniflare: Miniflare;

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [
      new URL(
        "../test/fixtures/inference-admission-gate-worker.ts",
        import.meta.url,
      ).pathname,
    ],
    format: "esm",
    target: "browser",
    conditions: ["worker", "browser"],
    plugins: [
      {
        name: "admission-runtime-boundaries",
        setup(build) {
          build.onLoad(
            { filter: /packages\/cloud\/shared\/src\/db\/client\.ts$/ },
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
              filter:
                /packages\/cloud\/shared\/src\/lib\/runtime\/cloud-bindings\.ts$/,
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
              filter:
                /packages\/cloud\/shared\/src\/lib\/services\/inference-admission-recovery\.ts$/,
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
            { filter: /packages\/cloud\/shared\/src\/lib\/utils\/logger\.ts$/ },
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
  if (!output) throw new Error("Admission test Worker bundle was not emitted");

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
