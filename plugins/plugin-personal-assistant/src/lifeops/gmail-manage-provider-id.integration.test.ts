/**
 * Gmail manage called with the Gmail provider message id (not the local id)
 * updates the cached message in place: it never overwrites it with a blank
 * placeholder, and delete removes it. Real LifeOpsService and repository on
 * PGlite; only the Google Workspace service (the connector) is a stand-in.
 */
import { afterEach, expect, it } from "vitest";
import type { RealTestRuntimeResult } from "../../test/helpers/runtime.js";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import { lifeOpsGmailMessageFromGoogle } from "./google-plugin-delegates.js";
import {
  createLifeOpsConnectorGrant,
  LifeOpsRepository,
} from "./repository.js";
import { LifeOpsService } from "./service.js";

const AT = "2026-10-10T18:00:00.000Z";

let fixture: RealTestRuntimeResult | null = null;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = null;
});

async function setup() {
  fixture = await createLifeOpsTestRuntime();
  const { runtime } = fixture;
  await LifeOpsRepository.bootstrapSchema(runtime);
  const repository = new LifeOpsRepository(runtime);
  const grant = {
    ...createLifeOpsConnectorGrant({
      agentId: runtime.agentId,
      provider: "google",
      connectorAccountId: "acct-1",
      identity: { email: "owner@example.test" },
      identityEmail: "owner@example.test",
      grantedScopes: [],
      capabilities: ["google.gmail.triage", "google.gmail.manage"],
      tokenRef: null,
      mode: "local",
      metadata: {},
      lastRefreshAt: AT,
    }),
    id: "connector-account:acct-1",
  };
  await repository.upsertGmailMessage(
    lifeOpsGmailMessageFromGoogle({
      agentId: runtime.agentId,
      grant,
      syncedAt: AT,
      message: {
        externalId: "18f00dprovider",
        threadId: "thread-1",
        subject: "Contract signature needed",
        from: "Alice",
        fromEmail: "alice@example.test",
        replyTo: null,
        to: ["owner@example.test"],
        cc: [],
        snippet: "Please sign by Friday",
        receivedAt: "2026-10-09T09:00:00.000Z",
        isUnread: true,
        isImportant: true,
        likelyReplyNeeded: true,
        triageScore: 90,
        triageReason: "Important",
        labels: ["INBOX", "UNREAD", "IMPORTANT"],
        htmlLink: null,
        metadata: { messageIdHeader: "<abc@example.test>" },
      },
    }),
  );
  // Connector boundary: the Google Workspace service accepts every id.
  const google = {
    async modifyGmailMessages(args: { messageIds: string[] }) {
      return {
        requestedMessageIds: args.messageIds,
        succeededMessageIds: args.messageIds,
        failures: [],
      };
    },
  };
  (runtime as unknown as { services: Map<string, unknown[]> }).services.set(
    "google",
    [google],
  );
  const service = new LifeOpsService(runtime, {
    ownerEntityId: runtime.agentId,
  });
  (
    service as unknown as { requireGoogleGmailGrant: () => Promise<unknown> }
  ).requireGoogleGmailGrant = async () => grant;
  const cachedRows = () =>
    repository.listGmailMessages(
      runtime.agentId,
      "google",
      { grantId: grant.id },
      "owner",
    );
  const manage = (operation: string) =>
    service.manageGmailMessages(
      new URL("http://localhost/api/lifeops/gmail/manage"),
      {
        operation,
        messageIds: ["18f00dprovider"],
        confirmAction: true,
      } as never,
    );
  return { cachedRows, manage };
}

it("mark_read by provider id keeps the cached message content", async () => {
  const { cachedRows, manage } = await setup();
  const result = await manage("mark_read");
  expect(result.status).toBe("executed");

  const rows = await cachedRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    subject: "Contract signature needed",
    receivedAt: "2026-10-09T09:00:00.000Z",
    labels: ["INBOX", "IMPORTANT"],
    isUnread: false,
  });
  expect(rows[0]?.metadata.messageIdHeader).toBe("<abc@example.test>");
}, 180_000);

it("delete by provider id removes the cached message", async () => {
  const { cachedRows, manage } = await setup();
  expect((await manage("delete")).status).toBe("executed");
  expect(await cachedRows()).toHaveLength(0);
}, 180_000);
