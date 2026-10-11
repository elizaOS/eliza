/** The Automations form's create and edit requests through the real Node HTTP trigger routes. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveDefaultTimeZone } from "@elizaos/contracts";
import { resolveOwnerEntityIdOrDefault } from "@elizaos/core";
import { registerHttpPluginRoutes } from "@elizaos/host/protocol";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  buildCreateRequest,
  buildUpdateRequest,
  emptyForm,
  formFromTrigger,
} from "../../../packages/ui/src/components/pages/trigger-form-utils.ts";
import { workflowRoutePlugin } from "../../../plugins/plugin-workflow/src/plugin-routes.ts";
import { registerTokenRoleResolver } from "../src/api/boundary-role-resolver.ts";
import { startApiServer } from "../src/api/server.ts";

let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;
let unregisterResolver: (() => void) | undefined;
let stateDir: string;

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "eliza-automations-form-"));
  await writeFile(path.join(stateDir, "eliza.json"), "{}");
  vi.stubEnv("ELIZA_STATE_DIR", stateDir);
  vi.stubEnv("ELIZA_CONFIG_PATH", path.join(stateDir, "eliza.json"));
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", path.join(stateDir, "eliza.json"));
  vi.stubEnv("ELIZA_API_BIND_HOST", "127.0.0.1");
  fixture = await createTestRuntime({ characterName: "AutomationsForm" });
  const owner = resolveOwnerEntityIdOrDefault(fixture.runtime);
  registerHttpPluginRoutes(fixture.runtime, workflowRoutePlugin);
  unregisterResolver = registerTokenRoleResolver({
    id: "automations-form-test",
    resolve: (req) =>
      req.headers["x-test-owner"] === "owner"
        ? {
            providerId: "automations-form-test",
            worldRole: "OWNER",
            principal: owner,
            isAdmin: true,
            isRouteInScope: () => true,
            claims: {},
          }
        : null,
  });
  server = await startApiServer({
    port: 0,
    runtime: fixture.runtime,
    skipDeferredStartupWork: true,
  });
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  unregisterResolver?.();
  if (fixture) await fixture.cleanup();
  vi.unstubAllEnvs();
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
}, 120_000);

function request(route: string, method: string, body: object) {
  return fetch(`http://127.0.0.1:${server.port}${route}`, {
    method,
    headers: { "x-test-owner": "owner", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

it("creates and edits a text automation from the form's requests", async () => {
  const form = {
    ...emptyForm,
    displayName: "Standup notes",
    instructions: "Summarize yesterday",
    kind: "text" as const,
    triggerType: "cron" as const,
    cronExpression: "0 9 * * 1-5",
  };
  const created = await request("/api/triggers", "POST", {
    ...buildCreateRequest(form),
    // The form sends the browser's zone; pin it so the test is host-independent.
    timezone: "America/Los_Angeles",
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const { trigger } = await created.json();
  expect(trigger).toMatchObject({
    kind: "prompt",
    timezone: "America/Los_Angeles",
  });

  const edited = formFromTrigger(trigger);
  expect(edited.kind).toBe("text");
  const updated = await request(`/api/triggers/${trigger.id}`, "PUT", {
    ...buildUpdateRequest(edited),
    displayName: "Standup summary",
  });
  expect(updated.status, await updated.clone().text()).toBe(200);
  expect((await updated.json()).trigger).toMatchObject({
    displayName: "Standup summary",
    kind: "prompt",
    timezone: "America/Los_Angeles",
  });
}, 120_000);

it("gives an edited cron trigger without a stored zone the zone the form previews", async () => {
  // An interval trigger (no zone) switched to cron in the form.
  const created = await request("/api/triggers", "POST", {
    ...buildCreateRequest({
      ...emptyForm,
      displayName: "Hourly check",
      instructions: "Check the inbox",
      kind: "text" as const,
      triggerType: "interval" as const,
    }),
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const { trigger } = await created.json();
  expect(trigger.timezone).toBeUndefined();

  const edited = {
    ...formFromTrigger(trigger),
    triggerType: "cron" as const,
    cronExpression: "0 9 * * 1-5",
  };
  const updated = await request(
    `/api/triggers/${trigger.id}`,
    "PUT",
    buildUpdateRequest(edited),
  );
  expect(updated.status, await updated.clone().text()).toBe(200);
  expect((await updated.json()).trigger).toMatchObject({
    triggerType: "cron",
    timezone: resolveDefaultTimeZone(),
  });
}, 120_000);
