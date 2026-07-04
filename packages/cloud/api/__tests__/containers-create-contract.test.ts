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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findReservedEnvKeys } from "@/lib/services/reserved-env-keys";
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

describe("edad README Option-B deploy body ↔ CreateContainerSchema (#11929)", () => {
  // The orchestrator's app-deploy guidance tells coding sub-agents to follow
  // the edad README's `POST /api/v1/containers` example VERBATIM, so this test
  // pins the doc to the real schema: the exact JSON body in the README must
  // round-trip with the sign-in + billing env keys intact. The pre-fix README
  // posted snake_case keys that zod silently stripped — every deploy built
  // from it shipped a container with NO env vars (dead sign-in + billing).
  const readmePath = fileURLToPath(
    new URL("../../../examples/cloud/edad/README.md", import.meta.url),
  );
  const readme = readFileSync(readmePath, "utf8");

  function extractCurlBody(markdown: string): Record<string, unknown> {
    // The single `curl … -d '{…}'` example in the Option-B deploy block.
    const match = markdown.match(/-d '(\{[\s\S]*?\})'/);
    if (!match) throw new Error("README curl -d body not found");
    return JSON.parse(match[1]) as Record<string, unknown>;
  }

  test("the README body parses with every posted key recognized (nothing silently stripped)", () => {
    const wire = extractCurlBody(readme);

    const parsed = CreateContainerSchema.safeParse(wire);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // zod strips unknown keys silently — equality of the key sets proves the
    // doc posts ONLY keys the schema actually accepts.
    expect(Object.keys(parsed.data).sort()).toEqual(Object.keys(wire).sort());
  });

  test("the sign-in + billing env keys survive to the container env", () => {
    const wire = extractCurlBody(readme);
    const parsed = CreateContainerSchema.safeParse(wire);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const env = parsed.data.environmentVars;
    expect(env).toBeDefined();
    if (!env) return;
    // Sign-in: the OAuth session exchange needs the app id; billing: the
    // owner cloud key funds `/api/v1/messages` forwards. server.ts reads
    // `ELIZAOS_CLOUD_API_KEY ?? ELIZA_CLOUD_API_KEY` — the container path must
    // use the second name (see the reserved-keys test below).
    expect(env.ELIZA_APP_ID).toBeTruthy();
    expect(env.ELIZA_CLOUD_API_KEY).toBeTruthy();
    expect(env.ELIZA_AFFILIATE_CODE).toBeTruthy();
    expect(env.ELIZA_CLOUD_URL).toBeTruthy();
  });

  test("the README env block carries no platform-reserved keys (route would 400)", () => {
    // POST /api/v1/containers rejects reserved keys (#9853) — a README body
    // using ELIZAOS_CLOUD_API_KEY would fail loudly with RESERVED_ENV_KEYS.
    const wire = extractCurlBody(readme);
    const env = (wire.environmentVars ?? {}) as Record<string, string>;
    expect(findReservedEnvKeys(Object.keys(env))).toEqual([]);
  });

  test("REGRESSION: the README no longer posts the legacy snake_case keys", () => {
    const wire = extractCurlBody(readme);
    for (const legacyKey of [
      "project_name",
      "environment_vars",
      "health_check_path",
      "memory",
    ]) {
      expect(wire).not.toHaveProperty(legacyKey);
    }
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
