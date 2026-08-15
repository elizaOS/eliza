/**
 * Drives the Discord connection PATCH route through validation and its atomic
 * repository boundary, including stale-editor rejection with no partial write.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { Hono } from "hono";
import * as realRepositories from "@/db/repositories";
import type { DiscordConnectionWithVersion } from "@/db/repositories/discord-connections";
import * as realAuth from "@/lib/auth";
import * as realWorkersAuth from "@/lib/auth/workers-hono-auth";
import type { AppEnv } from "@/types/cloud-worker-env";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const CONNECTION_ID = "33333333-3333-4333-8333-333333333333";
const UPDATED_AT = new Date("2026-08-15T09:00:00.000Z");

const connection: DiscordConnectionWithVersion = {
  id: CONNECTION_ID,
  organization_id: ORGANIZATION_ID,
  character_id: null,
  application_id: "discord-app",
  bot_user_id: null,
  bot_token_encrypted: "ciphertext",
  encrypted_dek: "dek",
  token_nonce: "nonce",
  token_auth_tag: "tag",
  encryption_key_id: "key",
  assigned_pod: "gateway-1",
  status: "connected",
  error_message: null,
  guild_count: 1,
  events_received: 2,
  events_routed: 2,
  last_heartbeat: null,
  connected_at: null,
  intents: 1,
  is_active: true,
  configuration_revision: 4271,
  metadata: {
    responseMode: "keyword",
    keywords: ["support"],
    enabledChannels: ["channel-allow"],
  },
  created_at: UPDATED_AT,
  updated_at: UPDATED_AT,
  edit_version: "4271",
};

const updatedConnection: DiscordConnectionWithVersion = {
  ...connection,
  configuration_revision: 4272,
  edit_version: "4272",
};

const findById = mock(async () => connection);
const findByOrganizationId = mock(async () => [connection]);
const updateConfiguration = mock(
  async (): Promise<DiscordConnectionWithVersion | null> => updatedConnection,
);
const realAuthSnapshot = { ...realAuth };
const realWorkersAuthSnapshot = { ...realWorkersAuth };
const realRepositoriesSnapshot = { ...realRepositories };
let detailApp: Hono<AppEnv>;
let listApp: Hono<AppEnv>;

beforeAll(async () => {
  mock.module("@/lib/auth", () => ({
    ...realAuthSnapshot,
    requireAuthOrApiKeyWithOrg: mock(async () => ({
      user: {
        id: USER_ID,
        organization_id: ORGANIZATION_ID,
      },
    })),
  }));
  mock.module("@/lib/auth/workers-hono-auth", () => ({
    ...realWorkersAuthSnapshot,
    requireUserOrApiKeyWithOrg: mock(async () => ({
      id: USER_ID,
      organization_id: ORGANIZATION_ID,
    })),
  }));
  mock.module("@/db/repositories", () => ({
    ...realRepositoriesSnapshot,
    discordConnectionsRepository: {
      ...realRepositoriesSnapshot.discordConnectionsRepository,
      findById,
      findByOrganizationId,
      updateConfiguration,
    },
  }));
  const detailRoute = (await import("../v1/discord/connections/[id]/route"))
    .default;
  const listRoute = (await import("../v1/discord/connections/route")).default;
  detailApp = new Hono<AppEnv>().route("/:id", detailRoute);
  listApp = new Hono<AppEnv>().route("/", listRoute);
});

beforeEach(() => {
  findById.mockClear();
  findByOrganizationId.mockClear();
  updateConfiguration.mockClear();
  updateConfiguration.mockResolvedValue(updatedConnection);
});

afterAll(() => {
  mock.module("@/lib/auth", () => realAuthSnapshot);
  mock.module("@/lib/auth/workers-hono-auth", () => realWorkersAuthSnapshot);
  mock.module("@/db/repositories", () => realRepositoriesSnapshot);
});

function patch(body: unknown): Promise<Response> {
  return Promise.resolve(
    detailApp.request(`http://test.local/${CONNECTION_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("PATCH /api/v1/discord/connections/:id metadata concurrency", () => {
  test("detail and list reads expose the same opaque edit version", async () => {
    const detail = await detailApp.request(
      `http://test.local/${CONNECTION_ID}`,
    );
    const list = await listApp.request("http://test.local/");

    expect(detail.status).toBe(200);
    expect(list.status).toBe(200);
    expect(await detail.text()).toContain('"editVersion":"4271"');
    expect(await list.text()).toContain('"editVersion":"4271"');
  });

  test("keeps versionless v1 clients on one atomic revision-advancing update", async () => {
    const response = await patch({
      metadata: { responseMode: "mention" },
    });

    expect(response.status).toBe(200);
    expect(updateConfiguration).toHaveBeenCalledWith(
      CONNECTION_ID,
      { metadata: { responseMode: "mention" } },
      undefined,
      undefined,
    );
    expect(await response.json()).toMatchObject({
      success: true,
      connection: { editVersion: "4272" },
    });
  });

  test("sends token and metadata through one conditional repository update", async () => {
    const metadata = {
      responseMode: "keyword" as const,
      keywords: ["support"],
      enabledChannels: ["channel-allow"],
      dmPolicy: "pairing" as const,
    };
    const response = await patch({
      metadata,
      botToken: "replacement-token",
      expectedEditVersion: "4271",
    });

    expect(response.status).toBe(200);
    expect(updateConfiguration).toHaveBeenCalledTimes(1);
    expect(updateConfiguration).toHaveBeenCalledWith(
      CONNECTION_ID,
      {
        assigned_pod: null,
        status: "pending",
        metadata,
      },
      4271,
      "replacement-token",
    );
    expect(await response.json()).toMatchObject({
      success: true,
      connection: { editVersion: "4272" },
    });
  });

  test("returns 409 and performs no legacy fallback when the row changed", async () => {
    updateConfiguration.mockResolvedValueOnce(null);
    const response = await patch({
      metadata: { responseMode: "always" },
      expectedEditVersion: "4271",
    });

    expect(response.status).toBe(409);
    expect(await response.text()).toBe(
      JSON.stringify({
        success: false,
        error: "Connection changed since editing began. Refresh and try again.",
      }),
    );
    expect(updateConfiguration).toHaveBeenCalledTimes(1);
  });

  test("rejects an edit-version-only no-op", async () => {
    const response = await patch({ expectedEditVersion: "4271" });

    expect(response.status).toBe(400);
    expect(updateConfiguration).not.toHaveBeenCalled();
  });

  test("rejects a revision that cannot be incremented in PostgreSQL", async () => {
    const response = await patch({
      metadata: { responseMode: "mention" },
      expectedEditVersion: "2147483647",
    });

    expect(response.status).toBe(400);
    expect(updateConfiguration).not.toHaveBeenCalled();
  });
});
