import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { gatewayReleaseLifecycle } from "./gateway-release-lifecycle";

const root = resolve(import.meta.dir, "../../..");
const tracked = Bun.TOML.parse(
  readFileSync(
    resolve(
      root,
      "packages/cloud/services/gateway-container/cloudflare/wrangler.toml",
    ),
    "utf8",
  ),
);
const classes = [
  "GatewayContainer",
  "NetworkConsentState",
  "DeliveryReceiptState",
  "WebhookIngressState",
  "DiscordWelcomeState",
  "DiscordCoordinationState",
];

describe("gateway release lifecycle", () => {
  test("retains every SQLite class, binding and resource without changing tracked config", () => {
    const before = structuredClone(tracked);
    const result = gatewayReleaseLifecycle(tracked, "staging");
    expect(result).not.toHaveProperty("migrations");
    expect(Object.keys(result.exports as object).sort()).toEqual(
      [...classes].sort(),
    );
    for (const name of classes)
      expect((result.exports as Record<string, unknown>)[name]).toEqual({
        type: "durable-object",
        storage: "sqlite",
      });
    expect(result.env).toEqual(tracked.env);
    expect(tracked).toEqual(before);
  });

  test("production preserves SQLite classes and bindings without reverting exports to migrations", () => {
    const before = structuredClone(tracked);
    const result = gatewayReleaseLifecycle(tracked, "production");
    expect(result).not.toHaveProperty("migrations");
    expect(result.exports).toEqual(
      gatewayReleaseLifecycle(tracked, "staging").exports,
    );
    expect(result.env).toEqual(tracked.env);
    expect(tracked).toEqual(before);
  });

  for (const environment of ["staging", "production"] as const) {
    test(`rejects non-additive, ambiguous and incomplete ${environment} histories`, () => {
      for (const history of [
        [{ tag: "v1", new_classes: ["GatewayContainer"] }],
        [{ tag: "v1", deleted_classes: ["GatewayContainer"] }],
        [
          {
            tag: "v1",
            renamed_classes: [{ from: "Old", to: "GatewayContainer" }],
          },
        ],
        [{ tag: "v1", transferred_classes: [] }],
        [
          {
            tag: "v1",
            new_sqlite_classes: ["GatewayContainer", "GatewayContainer"],
          },
        ],
        [{ tag: "v1", new_sqlite_classes: ["Other"] }],
        [{ tag: "v1", new_sqlite_classes: [] }],
        [
          { tag: "v1", new_sqlite_classes: ["GatewayContainer"] },
          { tag: "v1", new_sqlite_classes: ["Other"] },
        ],
      ])
        expect(() =>
          gatewayReleaseLifecycle(
            { ...tracked, migrations: history },
            environment,
          ),
        ).toThrow();
      expect(() =>
        gatewayReleaseLifecycle({ ...tracked, exports: {} }, environment),
      ).toThrow();
      expect(() =>
        gatewayReleaseLifecycle(
          { ...tracked, migrations: undefined },
          environment,
        ),
      ).toThrow();
    });
  }

  for (const environment of ["staging", "production"] as const) {
    test(`normal preparation writes the correct ${environment} lifecycle and exact image`, () => {
      const directory = mkdtempSync(
        resolve(tmpdir(), "gateway-release-control-"),
      );
      const image = `registry.cloudflare.com/23cf6feaeaa541f6a0675053c33da768/eliza-gateway-webhook-${environment}@sha256:${"0".repeat(64)}`;
      try {
        const child = Bun.spawnSync(
          [
            process.execPath,
            resolve(root, "packages/cloud/scripts/prepare-gateway-release.ts"),
          ],
          {
            cwd: root,
            env: {
              TARGET_ENVIRONMENT: environment,
              GATEWAY_RELEASE_IMAGE: image,
              RUNNER_TEMP: directory,
              CLOUDFLARE_ACCOUNT_ID: "23cf6feaeaa541f6a0675053c33da768",
              GATEWAY_RUNTIME_CONFIG: '{"fixture":"not-a-credential"}',
            },
          },
        );
        expect(child.exitCode).toBe(0);
        const generated = JSON.parse(
          readFileSync(resolve(directory, "gateway-wrangler.json"), "utf8"),
        );
        const selected = `webhook-${environment}`;
        expect(Object.keys(generated.env)).toEqual([selected]);
        expect(generated.env[selected].durable_objects).toEqual(
          tracked.env[selected].durable_objects,
        );
        expect(generated.env[selected].containers[0]).toEqual({
          ...Object.fromEntries(
            Object.entries(tracked.env[selected].containers[0]).filter(
              ([key]) =>
                !["image", "image_build_context", "image_vars"].includes(key),
            ),
          ),
          image,
        });
        expect(generated.main).toBe(
          resolve(
            root,
            "packages/cloud/services/gateway-container/cloudflare/worker.ts",
          ),
        );
        expect(generated).not.toHaveProperty("migrations");
        expect(Object.keys(generated.exports).sort()).toEqual(
          [...classes].sort(),
        );
        for (const name of classes)
          expect(generated.exports[name]).toEqual({
            type: "durable-object",
            storage: "sqlite",
          });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
