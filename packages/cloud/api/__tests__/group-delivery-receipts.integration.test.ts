/**
 * Exercises chunked provider delivery through the real receipt route and
 * migrated PGlite authority. Only Telegram's external HTTP API is simulated.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sendTelegramReply } from "@elizaos/cloud-services-common/telegram-connector";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

const { closeDatabaseConnectionsForTests, getPgliteClientForTests } =
  await import("@/db/client");
const { personalSharedGroupsRepository: repository } = await import(
  "@/db/repositories/personal-shared-groups"
);
const { default: app } = await import(
  "../internal/eliza-app/personal-shared/messages/route"
);
const database = getPgliteClientForTests();
const owner = "71000000-0000-4000-8000-000000000011";
const organization = "71000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  await database.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE users (
      id uuid PRIMARY KEY, organization_id uuid REFERENCES organizations(id),
      steward_user_id text, telegram_id text, phone_number text, phone_verified boolean,
      is_anonymous boolean, is_active boolean, deleted_at timestamptz
    );
  `);
  for (const migration of [
    "0297_personal_shared_group_bindings.sql",
    "0303_personal_shared_group_authority_version.sql",
    "0304_personal_shared_group_delivery_lease.sql",
    "0312_personal_shared_group_delivery_attempts.sql",
    "0311_personal_shared_group_participants.sql",
    "0320_personal_shared_multi_principal_consent.sql",
  ]) {
    await database.exec(
      await Bun.file(
        new URL(`../../shared/src/db/migrations/${migration}`, import.meta.url),
      ).text(),
    );
  }
  await database.query("INSERT INTO organizations (id) VALUES ($1)", [
    organization,
  ]);
  await database.query(
    "INSERT INTO users (id, organization_id) VALUES ($1, $2)",
    [owner, organization],
  );
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

test("reconciles every delivered chunk and releases the reservation for the next group turn", async () => {
  const destination = {
    platform: "telegram" as const,
    project: "eliza-app",
    connectorAccountId: "telegram:receipt-test",
    providerChatId: "-100123456789",
  };
  await repository.issueClaim({
    ...destination,
    codeHash: "chunked-receipt-test",
    organizationId: organization,
    ownerUserId: owner,
    personalAgentId: "personal:receipt-owner",
    issuedToPlatformUserId: "123456789",
    expiresAt: new Date(Date.now() + 60_000),
  });
  const bound = await repository.consumeClaimAndBind({
    ...destination,
    codeHash: "chunked-receipt-test",
    actorPlatformUserId: "123456789",
  });
  if (bound.status !== "bound") throw new Error("Group claim did not bind");
  const delivery = {
    ...destination,
    sourceMessageId: "telegram:eliza-app:chunked-reply",
    leaseToken: crypto.randomUUID(),
    authority: {
      bindingId: bound.binding.id,
      ownerUserId: owner,
      personalAgentId: bound.binding.personal_agent_id,
      version: bound.binding.authority_version,
    },
  };
  expect(
    await repository.authorizeDelivery({ ...delivery, invocation: "mention" }),
  ).toMatchObject({ authorized: true });
  expect(await repository.commitDelivery(delivery)).toBe(true);

  const text = "A complete group response. ".repeat(1800);
  const sentText: string[] = [];
  const acceptedIds: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body: unknown = JSON.parse(String(init?.body));
      if (
        !body ||
        typeof body !== "object" ||
        !("text" in body) ||
        typeof body.text !== "string"
      ) {
        throw new Error("Expected Telegram text send");
      }
      sentText.push(body.text);
      const id = 1000 + sentText.length;
      acceptedIds.push(String(id));
      return Response.json({ ok: true, result: { message_id: id } });
    },
    { preconnect: originalFetch.preconnect },
  );
  let receipt: Awaited<ReturnType<typeof sendTelegramReply>>;
  try {
    receipt = await sendTelegramReply(
      { botToken: "test-token" },
      {
        platform: "telegram",
        messageId: "chunked-reply",
        platformRecordId: "receipt-test",
        chatId: destination.providerChatId,
        chatType: "supergroup",
        senderId: "123456789",
        text: "Please explain",
        isCommand: false,
        rawPayload: {},
      },
      text,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(sentText.join("")).toBe(text);
  expect(receipt.providerMessageIds.length).toBeGreaterThan(8);
  expect(receipt.providerMessageIds).toEqual(acceptedIds);

  const submit = (providerMessageIds: string[]) =>
    app.request(
      "/",
      {
        method: "POST",
        headers: {
          authorization: "Bearer receipt-test-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...delivery,
          eventType: "delivery_receipt",
          chatId: destination.providerChatId,
          providerMessageIds,
        }),
      },
      { INTERNAL_SECRET: "receipt-test-secret" },
    );
  const invalid = await submit([...receipt.providerMessageIds, ""]);
  expect(invalid.status).toBe(400);
  expect((await submit([])).status).toBe(400);
  const response = await submit(receipt.providerMessageIds);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    success: true,
    data: { recorded: true, inserted: acceptedIds.length },
  });
  const persisted = await database.query<{ provider_message_id: string }>(
    "SELECT provider_message_id FROM personal_shared_group_delivery_receipts WHERE binding_id = $1",
    [bound.binding.id],
  );
  expect(persisted.rows.map((row) => row.provider_message_id).sort()).toEqual(
    [...acceptedIds].sort(),
  );
  const attempt = await database.query<{ state: string }>(
    "SELECT state FROM personal_shared_group_delivery_attempts WHERE binding_id = $1 AND source_message_id = $2",
    [bound.binding.id, delivery.sourceMessageId],
  );
  expect(attempt.rows).toEqual([{ state: "reconciled" }]);
  const replay = await submit(receipt.providerMessageIds);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({
    data: { recorded: true, inserted: 0 },
  });
  const binding = await repository.findBindingById(bound.binding.id);
  expect(binding?.delivery_lease_token).toBeNull();
  expect(
    await repository.authorizeDelivery({
      ...delivery,
      sourceMessageId: "telegram:eliza-app:next-turn",
      leaseToken: crypto.randomUUID(),
      invocation: "mention",
    }),
  ).toMatchObject({ authorized: true });
});
