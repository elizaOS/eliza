/**
 * Characters belong to their creator inside an organization. A Discord
 * connection runs its linked character (system prompt, documents, settings),
 * so creating or editing one must only accept the caller's own character.
 * Real POST and PATCH routes; the caller and the repositories are replaced.
 */
import { beforeEach, expect, mock, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";

const ORG = "11111111-1111-4111-8111-1111111111d1";
const MEMBER_B = "22222222-2222-4222-8222-2222222222d2";
const MEMBER_A = "22222222-2222-4222-8222-2222222222d1";
const A_CHARACTER = "33333333-3333-4333-8333-3333333333d1";
const B_CHARACTER = "33333333-3333-4333-8333-3333333333d2";
const B_CONNECTION = "44444444-4444-4444-8444-4444444444d2";

const caller = {
  id: MEMBER_B,
  organization_id: ORG,
  organization: { id: ORG, name: "Org", is_active: true },
  is_active: true,
  role: "member",
};
const realAuth = { ...(await import("@elizaos/cloud-shared/auth")) };
mock.module("@elizaos/cloud-shared/auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg: async () => caller,
}));
const realLibAuth = { ...(await import("@elizaos/cloud-shared/lib/auth")) };
mock.module("@elizaos/cloud-shared/lib/auth", () => ({
  ...realLibAuth,
  requireAuthOrApiKeyWithOrg: async () => ({ user: caller }),
}));

const { discordConnectionsRepository, userCharactersRepository } = await import(
  "@elizaos/cloud-shared/db/repositories"
);
const characters = new Map([
  [A_CHARACTER, { id: A_CHARACTER, user_id: MEMBER_A, organization_id: ORG }],
  [B_CHARACTER, { id: B_CHARACTER, user_id: MEMBER_B, organization_id: ORG }],
]);
const writes: Array<{ characterId?: string; character_id?: string }> = [];
const connectionRow = {
  id: B_CONNECTION,
  organization_id: ORG,
  application_id: "app-b",
  character_id: B_CHARACTER,
  status: "connected",
  metadata: {},
};
Object.assign(userCharactersRepository, {
  findById: async (id: string) => characters.get(id),
});
Object.assign(discordConnectionsRepository, {
  create: async (input: { characterId: string }) => {
    writes.push(input);
    return { ...connectionRow, character_id: input.characterId };
  },
  findById: async () => connectionRow,
  update: async (_id: string, input: { character_id?: string }) => {
    writes.push(input);
    return { ...connectionRow, ...input };
  },
});

const { Hono } = await import("hono");
const { default: connectionsRoute } = await import(
  "../v1/discord/connections/route"
);
const { default: connectionRoute } = await import(
  "../v1/discord/connections/[id]/route"
);
const app = new Hono()
  .route("/api/v1/discord/connections/:id", connectionRoute)
  .route("/api/v1/discord/connections", connectionsRoute);
const env = { NODE_ENV: "test", RATE_LIMIT_DISABLED: "true" };

function request(method: string, path: string, body: unknown) {
  return app.request(
    path,
    {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

beforeEach(() => {
  writes.length = 0;
});

test("creating a connection with another member's character is refused", async () => {
  const response = await request("POST", "/api/v1/discord/connections", {
    applicationId: "app-b",
    botToken: "bot-token-b",
    characterId: A_CHARACTER,
  });

  expect(response.status).toBe(404);
  expect(writes).toEqual([]);
});

test("moving a connection to another member's character is refused", async () => {
  const response = await request(
    "PATCH",
    `/api/v1/discord/connections/${B_CONNECTION}`,
    { characterId: A_CHARACTER },
  );

  expect(response.status).toBe(404);
  expect(writes).toEqual([]);
});

test("the caller's own character is still accepted", async () => {
  const response = await request("POST", "/api/v1/discord/connections", {
    applicationId: "app-b",
    botToken: "bot-token-b",
    characterId: B_CHARACTER,
  });

  expect(response.status).toBe(200);
  expect(writes.map((write) => write.characterId)).toEqual([B_CHARACTER]);
});
