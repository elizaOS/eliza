/** Replays the purges of quint/GmailGrantPurge.qnt through the Gmail cleanup of disconnect and account handoff on PGlite; no provider account is disconnected or messaged. */

import { readFileSync } from "node:fs";
import type { LifeOpsConnectorGrant } from "@elizaos/contracts";
import {
  CalendarService,
  createDefaultCalendarHostGate,
} from "@elizaos/plugin-calendar";
import { resolveKnowledgeGraphService } from "@elizaos/plugin-relationships";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { googleHandoffFixture } from "../../test/helpers/handoff-google.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import { GoogleWorkspaceTestService } from "../../test/stubs/plugin-google-workspace.js";
import { AccountHandoffAdmission } from "./account-handoff-admission.js";
import { AccountHandoffCalendarMappings } from "./account-handoff-calendar-mappings.js";
import { AccountHandoffDataDisposition } from "./account-handoff-data-disposition.js";
import { AccountHandoffDisconnect } from "./account-handoff-disconnect.js";
import { AccountHandoffRecipients } from "./account-handoff-recipients.js";
import { AccountHandoffStore } from "./account-handoff-store.js";
import { AccountHandoffVerification } from "./account-handoff-verification.js";
import { lifeOpsGmailMessageFromGoogle } from "./google-plugin-delegates.js";
import {
  createLifeOpsGmailSyncState,
  LifeOpsRepository,
} from "./repository.js";
import { LifeOpsService } from "./service.js";
import type { LifeOpsGoogleService } from "./service-mixin-google.js";
import { executeRawSql, sqlQuote } from "./sql.js";

/** The local Gmail rows of one account in the model. */
interface ModelRows {
  mail: boolean;
  cursor: boolean;
}

/** Saved rows of the three accounts and the syncs and purges that follow, with the rows after each. */
interface ModelCase {
  start: ModelRows[];
  steps: Array<
    { purge: number; rows: ModelRows[] } | { sync: number; rows: ModelRows[] }
  >;
}

const PURGES = [
  "disconnecting the previous account",
  "disconnecting the replacement account",
  "disconnecting the agent account",
  "the handoff removing old imports",
];
const HANDOFF = 3;
const NONE: ModelRows = { mail: false, cursor: false };
const CURSOR: ModelRows = { mail: false, cursor: true };
const IMPORTED: ModelRows = { mail: true, cursor: true };

// The cursor of a purged account must not survive its purge.
const DEFAULT_CASES: ModelCase[] = [
  {
    start: [IMPORTED, IMPORTED, IMPORTED],
    steps: [{ purge: 0, rows: [NONE, IMPORTED, IMPORTED] }],
  },
  {
    start: [CURSOR, IMPORTED, NONE],
    steps: [
      { purge: 1, rows: [CURSOR, NONE, NONE] },
      { purge: 0, rows: [NONE, NONE, NONE] },
    ],
  },
  {
    start: [IMPORTED, IMPORTED, IMPORTED],
    steps: [
      { purge: 2, rows: [IMPORTED, IMPORTED, NONE] },
      { sync: 2, rows: [IMPORTED, IMPORTED, IMPORTED] },
    ],
  },
  {
    start: [IMPORTED, CURSOR, IMPORTED],
    steps: [
      { purge: HANDOFF, rows: [NONE, CURSOR, IMPORTED] },
      { purge: 2, rows: [NONE, CURSOR, NONE] },
    ],
  },
];

const casesFile = process.env.ELIZA_GMAIL_GRANT_PURGE_MODEL_CASES;
const cases: ModelCase[] = casesFile
  ? JSON.parse(readFileSync(casesFile, "utf8"))
  : DEFAULT_CASES;

let host: RealTestRuntimeResult;
beforeAll(async () => {
  host = await createLifeOpsTestRuntime();
  await host.runtime.registerService(GoogleWorkspaceTestService);
}, 60_000);
afterAll(async () => {
  await host.cleanup();
});

/** The handoff fixture's previous and replacement owner accounts and an agent-side account. */
function modelAccounts() {
  const f = googleHandoffFixture();
  f.grant.agentId = host.runtime.agentId;
  f.review.readCalendars = [];
  f.review.writeCalendar = null;
  f.review.importedData = "remove_previous_account_imports";
  const previousGrant: LifeOpsConnectorGrant = {
    ...f.grant,
    id: f.review.previous.grantId,
    connectorAccountId: f.review.previous.connectorAccountId,
    identityEmail: f.review.previous.email,
  };
  const agentGrant: LifeOpsConnectorGrant = {
    ...f.grant,
    id: "agent-grant",
    connectorAccountId: "agent",
    side: "agent",
    identity: { email: "agent@example.test" },
    identityEmail: "agent@example.test",
  };
  return { f, previousGrant, grants: [previousGrant, f.grant, agentGrant] };
}

/** Brings a real handoff from the previous to the replacement owner account to its disposing_imports phase. */
async function handoffAtDisposition(owner: string) {
  const { f, previousGrant } = modelAccounts();
  const statuses = [f.status, { ...f.status, grant: previousGrant }];
  const provider = await host.runtime.getServiceLoadPromise("google");
  Object.assign(provider, { listCalendars: f.google.listCalendars });
  const calendar = new CalendarService(host.runtime);
  calendar.setGate({
    ...createDefaultCalendarHostGate(host.runtime),
    getGoogleConnectorAccounts: async () => statuses,
  });
  const graph = resolveKnowledgeGraphService(host.runtime);
  if (!graph) throw new Error("Fixture identity service missing");
  await graph.getEntityStore(host.runtime.agentId).upsert({
    entityId: owner,
    type: "person",
    preferredName: owner,
    identities: [
      {
        platform: "email",
        handle: "self@example.test",
        connectorAccountId: "default",
        verified: true,
        confidence: 1,
        addedAt: "2026-09-01T00:00:00Z",
        addedVia: "user_chat",
        evidence: ["Owner confirmed this address"],
      },
    ],
    tags: [],
    visibility: "owner_only",
    state: {},
  });
  const store = new AccountHandoffStore(host.runtime, owner);
  const url = new URL("http://localhost");
  let state = await store.review(owner, f.review);
  state = await new AccountHandoffRecipients(host.runtime, owner).capture(
    state.operationId,
    state.revision,
    [owner],
  );
  const admission = new AccountHandoffAdmission(
    host.runtime,
    owner,
    calendar,
    url,
  );
  state = await admission.begin(state.operationId, state.revision);
  state = await admission.pause(state.operationId, state.revision);
  state = await admission.drain(state.operationId, state.revision);
  state = await admission.retireApprovals(state.operationId, state.revision);
  const mappings = new AccountHandoffCalendarMappings(
    host.runtime,
    owner,
    calendar,
    url,
  );
  state = await mappings.applyNext(state.operationId, state.revision);
  state = await mappings.applyNext(state.operationId, state.revision);
  state = await new AccountHandoffVerification(
    host.runtime,
    owner,
    calendar,
    f.accounts,
    f.google,
    url,
  ).verifyGoogle(state.operationId, state.revision);
  // Destination verification before this phase is a fixture boundary. The
  // connector port below is deterministic, not evidence of a live disconnect.
  state = await store.advance({
    operationId: state.operationId,
    expectedRevision: state.revision,
    expectedPhase: "verifying_replacement",
    phase: "disconnecting_previous",
    receipt: {},
  });
  const accounts: Pick<
    LifeOpsGoogleService,
    | "getGoogleConnectorStatus"
    | "getGoogleConnectorAccounts"
    | "disconnectGoogleConnector"
  > = {
    ...f.accounts,
    getGoogleConnectorAccounts: async () => statuses,
    disconnectGoogleConnector: async (request) => {
      const index = statuses.findIndex(
        ({ grant }) => grant?.id === request.grantId,
      );
      if (index < 0) throw new Error("The fixture account was already removed");
      statuses.splice(index, 1);
      return f.status;
    },
  };
  state = await new AccountHandoffDisconnect(
    host.runtime,
    owner,
    calendar,
    accounts,
    f.google,
    url,
  ).apply(state.operationId, state.revision);
  expect(state.phase).toBe("disposing_imports");
  return () =>
    new AccountHandoffDataDisposition(
      host.runtime,
      owner,
      calendar,
      accounts,
      url,
    ).apply(state.operationId, state.revision);
}

async function replay(item: ModelCase, index: number) {
  const agentId = host.runtime.agentId;
  const repository = new LifeOpsRepository(host.runtime);
  const { grants } = modelAccounts();
  // Only a sequence with the handoff needs a handoff at its disposition phase.
  const dispose = item.steps.some(
    (step) => "purge" in step && step.purge === HANDOFF,
  )
    ? await handoffAtDisposition(`gmail-purge-model-${index}`)
    : null;
  for (const table of [
    "life_gmail_messages",
    "life_gmail_sync_states",
    "life_inbox_messages",
  ])
    await executeRawSql(
      host.runtime,
      `DELETE FROM app_lifeops.${table} WHERE agent_id = ${sqlQuote(agentId)}`,
    );
  const importMail = async (grant: LifeOpsConnectorGrant) => {
    const message = lifeOpsGmailMessageFromGoogle({
      agentId,
      grant,
      message: {
        externalId: `message-of-${grant.id}`,
        threadId: `thread-of-${grant.id}`,
        subject: `Imported for ${grant.id}`,
        from: "Sender",
        fromEmail: "sender@example.test",
        replyTo: null,
        to: [],
        cc: [],
        snippet: "Imported",
        receivedAt: "2026-09-01T00:00:00Z",
        isUnread: true,
        isImportant: false,
        likelyReplyNeeded: false,
        triageScore: 0,
        triageReason: "Imported",
        labels: [],
        htmlLink: null,
        metadata: {},
      },
      syncedAt: "2026-09-01T00:00:00Z",
    });
    await repository.upsertGmailMessage(message, grant.side);
    await repository.upsertCachedInboxMessages(agentId, [
      {
        id: `gmail:copy-of-${grant.id}`,
        channel: "gmail",
        sender: {
          id: `sender-of-${grant.id}`,
          displayName: "Sender",
          email: "sender@example.test",
          avatarUrl: null,
        },
        subject: `Imported for ${grant.id}`,
        snippet: "Imported",
        receivedAt: "2026-09-01T00:00:00Z",
        unread: true,
        deepLink: null,
        sourceRef: { channel: "gmail", externalId: `copy-of-${grant.id}` },
        threadId: `thread-of-${grant.id}`,
        chatType: "dm",
        gmailAccountId: grant.id,
        gmailAccountEmail: grant.identityEmail ?? "owner@example.test",
        connectorAccountId: grant.connectorAccountId ?? "default",
      },
    ]);
  };
  const saveCursor = (grant: LifeOpsConnectorGrant) =>
    repository.upsertGmailSyncState(
      createLifeOpsGmailSyncState({
        agentId,
        provider: "google",
        side: grant.side,
        mailbox: "me",
        grantId: grant.id,
        maxResults: 50,
        historyId: `history-of-${grant.id}`,
        cursorStatus: "incremental",
        fullResyncReason: null,
        syncedAt: "2026-09-01T00:00:00Z",
      }),
    );
  const read = async (): Promise<Array<ModelRows & { inboxCopy: boolean }>> => {
    const copies = await repository.listCachedInboxMessages(agentId, {
      channels: ["gmail"],
    });
    return Promise.all(
      grants.map(async (grant) => ({
        mail:
          (
            await repository.listGmailMessages(
              agentId,
              "google",
              { grantId: grant.id },
              grant.side,
            )
          ).length > 0,
        inboxCopy: copies.some((copy) => copy.gmailAccountId === grant.id),
        cursor:
          (await repository.getGmailSyncState(
            agentId,
            "google",
            "me",
            grant.side,
            grant.id,
          )) !== null,
      })),
    );
  };
  const expectRows = async (expected: ModelRows[], label: string) => {
    expect(await read(), label).toEqual(
      expected.map((rows) => ({ ...rows, inboxCopy: rows.mail })),
    );
  };
  for (const [grant, rows] of item.start.entries()) {
    if (rows.mail) await importMail(grants[grant]);
    if (rows.cursor) await saveCursor(grants[grant]);
  }
  await expectRows(item.start, "saved rows");
  const service = new LifeOpsService(host.runtime);
  for (const [position, step] of item.steps.entries()) {
    if ("sync" in step) {
      await importMail(grants[step.sync]);
      await saveCursor(grants[step.sync]);
      await expectRows(step.rows, `step ${position + 1}: sync ${step.sync}`);
      continue;
    }
    const label = `step ${position + 1}: ${PURGES[step.purge]}`;
    if (step.purge === HANDOFF) {
      if (!dispose) throw new Error("The handoff was not prepared");
      const completed = await dispose();
      expect(completed.receipt.importedDataDisposition, label).toMatchObject({
        disposition: "remove_previous_account_imports",
        grantId: grants[0].id,
      });
    } else {
      await service.clearGoogleGrantData(grants[step.purge]);
    }
    await expectRows(step.rows, label);
  }
}

describe("gmail grant purge model", () => {
  it.each(PURGES.map((name, purge) => ({ name, purge })))(
    "replays the gmail grant purge model when the first purge is $name",
    async ({ purge }) => {
      const own = cases.filter(
        (item) => item.steps.find((step) => "purge" in step)?.purge === purge,
      );
      expect(own.length).toBeGreaterThan(0);
      for (const item of own) {
        await replay(item, cases.indexOf(item));
      }
    },
    900_000,
  );
});
