import { beforeEach, expect, mock, test } from "bun:test";
import { AgentGoogleConnectorError } from "../../../../../../../shared/src/lib/services/agent-google-connector/shared";

const ETAG = '"3181161784712000"';
const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
let failWith: AgentGoogleConnectorError | null = null;

mock.module("@elizaos/cloud-shared/lib/auth/private-owner-credential", () => ({
  requirePrivateOwnerCredential: async () => {},
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/agent-google-route-deps",
  () => ({
    agentGoogleRouteDeps: {
      AgentGoogleConnectorError,
      requireAuthOrApiKeyWithOrg: async () => ({
        user: { id: "owner-1", organization_id: "org-1" },
        authMethod: "session",
      }),
      updateManagedGoogleCalendarEvent: async (
        input: Record<string, unknown>,
      ) => {
        calls.push({ op: "update", input });
        if (failWith) throw failWith;
        return { event: { externalId: "event-1", etag: '"3181161784799999"' } };
      },
      deleteManagedGoogleCalendarEvent: async (
        input: Record<string, unknown>,
      ) => {
        calls.push({ op: "delete", input });
        if (failWith) throw failWith;
        return { ok: true };
      },
    },
  }),
);

const { default: app } = await import("./route");
const { Hono } = await import("hono");
const mounted = new Hono().route("/events/:eventId", app);

const patch = (headers: Record<string, string> = {}) =>
  mounted.request("/events/event-1", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ title: "Moved" }),
  });
const del = (headers: Record<string, string> = {}) =>
  mounted.request("/events/event-1", { method: "DELETE", headers });

beforeEach(() => {
  calls.length = 0;
  failWith = null;
});

test("PATCH passes If-Match through and answers the new revision as ETag", async () => {
  const response = await patch({ "if-match": ETAG });
  expect(response.status).toBe(200);
  expect(response.headers.get("etag")).toBe('"3181161784799999"');
  expect(calls[0].input).toMatchObject({
    eventId: "event-1",
    ifMatch: ETAG,
    title: "Moved",
  });
  await patch();
  expect(calls[1].input).not.toHaveProperty("ifMatch");
});

test("DELETE passes If-Match through", async () => {
  expect((await del({ "if-match": ETAG })).status).toBe(200);
  expect(calls[0]).toMatchObject({ op: "delete", input: { ifMatch: ETAG } });
});

test("a wildcard, list or empty If-Match is refused before Google is called", async () => {
  for (const value of ["*", `${ETAG}, "other"`, " "]) {
    expect((await patch({ "if-match": value })).status).toBe(400);
    expect((await del({ "if-match": value })).status).toBe(400);
  }
  expect(calls).toHaveLength(0);
});

test("a stale revision is 412 precondition_failed", async () => {
  failWith = new AgentGoogleConnectorError(
    412,
    "The event changed since it was read.",
  );
  for (const response of [
    await patch({ "if-match": ETAG }),
    await del({ "if-match": ETAG }),
  ]) {
    expect(response.status).toBe(412);
    expect((await response.json()) as unknown).toEqual({
      error: "The event changed since it was read.",
      code: "precondition_failed",
    });
  }
});
