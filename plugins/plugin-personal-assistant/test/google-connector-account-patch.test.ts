/**
 * Exercises PATCH /api/connectors/google/accounts/:accountId through the real
 * connector account route, account manager and Google account provider, with
 * the arguments the LifeOps route plugin passes. The account card sends one
 * field per PATCH; the other fields must stay as they are.
 */
import type http from "node:http";
import { handleConnectorAccountRoutes } from "@elizaos/agent/api/connector-account-routes";
import {
  AgentRuntime,
  createCharacter,
  getConnectorAccountManager,
  InMemoryConnectorAccountStorage,
} from "@elizaos/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createGoogleConnectorAccountProvider } from "../../plugin-google-workspace/src/connector-account-provider.js";

let runtime: AgentRuntime;

beforeEach(() => {
  runtime = new AgentRuntime({
    character: createCharacter({ name: "Google account patch" }),
  });
  getConnectorAccountManager(
    runtime,
    new InMemoryConnectorAccountStorage(),
  ).registerProvider(createGoogleConnectorAccountProvider(runtime));
});

afterEach(async () => {
  await runtime.stop();
});

async function send(method: string, pathname: string, body: object) {
  let response: { status: number; body: Record<string, unknown> } | undefined;
  await handleConnectorAccountRoutes({
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method,
    pathname,
    state: { runtime },
    json: (_res, data, status = 200) => {
      response = { status, body: data as Record<string, unknown> };
    },
    error: (_res, message, status = 500) => {
      response = { status, body: { error: message } };
    },
    readJsonBody: async <T extends object>() => body as T,
    authorize: async () => true,
  });
  return response;
}

it("keeps the label and enabled state that a single-field PATCH leaves out", async () => {
  const created = await send("POST", "/api/connectors/google/accounts", {
    label: "Work Google",
    role: "AGENT",
    status: "connected",
    externalId: "google-subject-1",
  });
  expect(created?.status).toBe(201);
  const path = `/api/connectors/google/accounts/${created?.body.id}`;

  expect((await send("PATCH", path, { enabled: false }))?.body).toMatchObject({
    label: "Work Google",
    role: "AGENT",
    enabled: false,
  });
  expect(
    (await send("PATCH", path, { label: "Team Google" }))?.body,
  ).toMatchObject({
    label: "Team Google",
    role: "AGENT",
    enabled: false,
  });
});
