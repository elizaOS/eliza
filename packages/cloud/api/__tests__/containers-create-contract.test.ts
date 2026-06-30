/**
 * Container create/update wire-contract tests.
 *
 * Proves the fix for the casing bug that silently dropped `ELIZA_APP_ID`:
 * the `@elizaos/cloud-sdk` request types are camelCase, and the server zod
 * schema (the source of truth, here imported directly — no mock) is camelCase
 * too, so an SDK-shaped body now round-trips with every field intact. The
 * regression cases reproduce the original bug: a snake_case body parses
 * "successfully" but with `projectName`, `environmentVars` (and thus
 * `ELIZA_APP_ID`), `memoryMb`, and `healthCheckPath` silently stripped.
 *
 * The bodies below are the exact shapes the SDK serializes for
 * `createContainer(req: CreateContainerRequest)` and
 * `updateContainer(id, req: UpdateContainerRequest)` — those types are pinned
 * to these keys by the compile-time test in
 * `packages/cloud/sdk/src/client.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
  CreateContainerSchema,
  PatchContainerSchema,
} from "../v1/containers/schema";

describe("POST /api/v1/containers — create contract (casing bug fix)", () => {
  test("a camelCase SDK body round-trips with ELIZA_APP_ID and projectName intact", () => {
    // Exactly what ElizaCloudClient.createContainer puts on the wire for the
    // fixed CreateContainerRequest type.
    const sdkBody = {
      name: "My App",
      image: "ghcr.io/elizaos/my-app:latest",
      projectName: "my-app",
      port: 3000,
      cpu: 1792,
      memoryMb: 1792,
      environmentVars: { ELIZA_APP_ID: "app_abc123", FOO: "bar" },
      healthCheckPath: "/health",
    };
    // Simulate the JSON transit the Worker performs (c.req.json()).
    const wire = JSON.parse(JSON.stringify(sdkBody));

    const parsed = CreateContainerSchema.safeParse(wire);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // The two fields the bug dropped now survive end to end.
    expect(parsed.data.projectName).toBe("my-app");
    expect(parsed.data.environmentVars?.ELIZA_APP_ID).toBe("app_abc123");
    // And the rest of the camelCase surface survives too.
    expect(parsed.data.memoryMb).toBe(1792);
    expect(parsed.data.healthCheckPath).toBe("/health");
    expect(parsed.data.port).toBe(3000);
    expect(parsed.data.cpu).toBe(1792);
  });

  test("REGRESSION: the old snake_case body silently drops ELIZA_APP_ID and projectName", () => {
    // The body the pre-fix SDK type produced. zod strips unknown keys, so this
    // parses "successfully" while losing everything but name+image.
    const legacyBody = {
      name: "My App",
      image: "ghcr.io/elizaos/my-app:latest",
      project_name: "my-app",
      environment_vars: { ELIZA_APP_ID: "app_abc123" },
      memory: 1792,
      health_check_path: "/health",
    };
    const wire = JSON.parse(JSON.stringify(legacyBody));

    const parsed = CreateContainerSchema.safeParse(wire);
    // It does NOT fail — that is the insidious part: no error surfaces.
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // Everything carried in snake_case is gone — environmentVars never existed,
    // so ELIZA_APP_ID (per-app monetization attribution) is lost.
    expect(parsed.data.projectName).toBeUndefined();
    expect(parsed.data.environmentVars).toBeUndefined();
    expect(parsed.data.environmentVars?.ELIZA_APP_ID).toBeUndefined();
    expect(parsed.data.memoryMb).toBeUndefined();
    expect(parsed.data.healthCheckPath).toBeUndefined();

    // And none of the snake_case keys leaked through onto the parsed output.
    expect(parsed.data).not.toHaveProperty("project_name");
    expect(parsed.data).not.toHaveProperty("environment_vars");
  });

  test("rejects a body missing the required image (server is the source of truth)", () => {
    const parsed = CreateContainerSchema.safeParse({ name: "no-image" });
    expect(parsed.success).toBe(false);
  });
});

describe("PATCH /api/v1/containers/:id — update contract (SDK union ↔ server)", () => {
  test("every UpdateContainerRequest variant passes the server PatchSchema", () => {
    // The three shapes of the SDK's UpdateContainerRequest discriminated union.
    const restart = { action: "restart" };
    const setEnv = {
      action: "setEnv",
      environmentVars: { ELIZA_APP_ID: "app_abc123" },
    };
    const scale = { action: "scale", desiredCount: 1 };

    expect(PatchContainerSchema.safeParse(restart).success).toBe(true);
    expect(PatchContainerSchema.safeParse(setEnv).success).toBe(true);
    expect(PatchContainerSchema.safeParse(scale).success).toBe(true);
  });

  test("REGRESSION: the old { desired_count } / partial-create body is rejected", () => {
    // The pre-fix UpdateContainerRequest extended Partial<CreateContainerRequest>,
    // so callers sent bodies with no `action` — which the server always 400s.
    expect(PatchContainerSchema.safeParse({ desired_count: 1 }).success).toBe(
      false,
    );
    expect(
      PatchContainerSchema.safeParse({ name: "x", projectName: "y" }).success,
    ).toBe(false);
  });
});
