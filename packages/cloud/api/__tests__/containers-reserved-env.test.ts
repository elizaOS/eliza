/**
 * #9853 — POST /api/v1/containers must reject caller-supplied reserved/managed
 * env keys (DATABASE_URL, ELIZA_API_TOKEN, STEWARD_AGENT_TOKEN, …) BEFORE any
 * provisioning, so an org cannot shadow the platform-injected DB DSN / cloud
 * token on its container. The app-deploy route already strips the same denylist;
 * this route previously forwarded `environmentVars` raw.
 *
 * The reserved-key guard runs immediately after auth + body-parse, before the
 * idempotency lookup / image allowlist / quota / Hetzner client, so the reject
 * path is exercised with only the auth dependency mocked — a 400 here proves no
 * provisioning was started.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as loggerActual from "@/lib/utils/logger";

const requireUserOrApiKeyWithOrg =
  mock<(c: unknown) => Promise<{ id: string; organization_id: string }>>();

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/utils/logger", () => ({
  ...loggerActual,
  logger: {
    ...loggerActual.logger,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

let app: Hono;

beforeEach(async () => {
  requireUserOrApiKeyWithOrg.mockReset();
  requireUserOrApiKeyWithOrg.mockResolvedValue({
    id: "user-1",
    organization_id: "org-1",
  });
  const { default: containersRoute } = (await import(
    "../v1/containers/route"
  )) as { default: Parameters<Hono["route"]>[1] };
  app = new Hono().route("/api/v1/containers", containersRoute);
});

afterEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
});

async function post(body: unknown): Promise<Response> {
  return await app.request("/api/v1/containers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const RESERVED_CASES = [
  "DATABASE_URL",
  "ELIZA_API_TOKEN",
  "ELIZAOS_CLOUD_API_KEY",
  "STEWARD_AGENT_TOKEN",
  // case-insensitive: a lowercase key must be caught too
  "database_url",
];

describe("POST /api/v1/containers reserved-env guard (#9853)", () => {
  for (const key of RESERVED_CASES) {
    test(`rejects a reserved env key (${key}) with 400 before provisioning`, async () => {
      const res = await post({
        name: "my-app",
        image: `ghcr.io/elizaos/app@sha256:${"a".repeat(64)}`,
        environmentVars: { [key]: "attacker-controlled" },
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { success: boolean; code?: string };
      expect(json.success).toBe(false);
      expect(json.code).toBe("RESERVED_ENV_KEYS");
    });
  }

  test("a benign env key passes the reserved-key guard (fails later, not with RESERVED_ENV_KEYS)", async () => {
    const res = await post({
      name: "my-app",
      image: `ghcr.io/elizaos/app@sha256:${"a".repeat(64)}`,
      environmentVars: { MY_APP_FLAG: "1" },
    });
    // Past the guard: it does NOT 400 with the reserved-key code. (It may fail
    // downstream on allowlist/quota/provisioning — that's not this guard.)
    if (res.status === 400) {
      const json = (await res.json()) as { code?: string };
      expect(json.code).not.toBe("RESERVED_ENV_KEYS");
    }
  });
});
