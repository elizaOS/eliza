/** The internal consent route authenticates the gateway and appends validated entries. */

import { beforeEach, expect, mock, test } from "bun:test";

const appended: unknown[] = [];
const actual = await import("@/lib/network/consent");
mock.module("@/lib/network/consent", () => ({
  ...actual,
  networkConsentWriter: {
    append: async (entry: unknown) => {
      appended.push(entry);
      return { recorded: true };
    },
  },
}));
const { default: route } = await import("./route");

const SECRET = "consent-route-secret";
const entry = {
  project: "network",
  channel: "twilio",
  address: "+14155550123",
  state: "opted_out",
  source: "keyword:STOP",
  providerMessageId: "SM1",
  at: "2026-10-06T18:00:00.000Z",
};

async function post(body: unknown, authorization = `Bearer ${SECRET}`) {
  const response = await route.request(
    "/",
    {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    { INTERNAL_SECRET: SECRET },
  );
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  appended.length = 0;
});

test("appends a valid Network consent entry", async () => {
  expect(await post(entry)).toEqual({
    status: 200,
    body: { success: true, data: { recorded: true } },
  });
  expect(appended).toEqual([entry]);
});

test("rejects unauthenticated callers, other projects and malformed entries", async () => {
  expect((await post(entry, "Bearer wrong")).status).toBe(401);
  expect((await post({ ...entry, project: "eliza-app" })).status).toBe(400);
  expect((await post({ ...entry, providerMessageId: undefined })).status).toBe(
    400,
  );
  expect(appended).toEqual([]);
});
