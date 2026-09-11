/** Real PGlite cleanup and checkpoint recovery with deterministic connector operations; no provider account is disconnected or messaged. */
import { CalendarService } from "@elizaos/plugin-calendar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { googleHandoffFixture } from "../../test/helpers/handoff-google.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import { AccountHandoffAdmission } from "./account-handoff-admission.js";
import { AccountHandoffCalendarMappings } from "./account-handoff-calendar-mappings.js";
import { AccountHandoffDataDisposition } from "./account-handoff-data-disposition.js";
import { AccountHandoffDisconnect } from "./account-handoff-disconnect.js";
import { AccountHandoffStore } from "./account-handoff-store.js";
import { AccountHandoffVerification } from "./account-handoff-verification.js";
import { lifeOpsGmailMessageFromGoogle } from "./google-plugin-delegates.js";
import { LifeOpsRepository } from "./repository.js";
import type { LifeOpsGoogleService } from "./service-mixin-google.js";
import { executeRawSql } from "./sql.js";

let host: RealTestRuntimeResult;
beforeAll(async () => {
  host = await createLifeOpsTestRuntime();
}, 60_000);
afterAll(async () => {
  await host.cleanup();
});

async function prepared(
  owner: string,
  remove = true,
  performDisconnect = true,
) {
  const f = googleHandoffFixture();
  f.grant.agentId = host.runtime.agentId;
  f.review.readCalendars = [];
  f.review.writeCalendar = null;
  f.review.importedData = remove ? "remove_previous_account_imports" : "retain";
  const calendar = new CalendarService(host.runtime);
  const store = new AccountHandoffStore(host.runtime, owner);
  const url = new URL("http://localhost");
  let state = await store.review(owner, f.review);
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
  const previousGrant = {
    ...f.grant,
    id: f.review.previous.grantId,
    connectorAccountId: f.review.previous.connectorAccountId,
    identityEmail: f.review.previous.email,
  };
  const statuses = [f.status, { ...f.status, grant: previousGrant }];
  const disconnectCalls: Array<
    Parameters<LifeOpsGoogleService["disconnectGoogleConnector"]>[0]
  > = [];
  const accounts: Pick<
    LifeOpsGoogleService,
    | "getGoogleConnectorStatus"
    | "getGoogleConnectorAccounts"
    | "disconnectGoogleConnector"
  > = {
    ...f.accounts,
    getGoogleConnectorAccounts: async () => statuses,
    disconnectGoogleConnector: async (request) => {
      disconnectCalls.push(request);
      const index = statuses.findIndex(
        ({ grant }) => grant?.id === request.grantId,
      );
      if (index < 0) throw new Error("The fixture account was already removed");
      statuses.splice(index, 1);
      return f.status;
    },
  };
  const disconnect = () =>
    new AccountHandoffDisconnect(
      host.runtime,
      owner,
      calendar,
      accounts,
      f.google,
      url,
    );
  if (performDisconnect)
    state = await disconnect().apply(state.operationId, state.revision);
  const service = () =>
    new AccountHandoffDataDisposition(
      host.runtime,
      owner,
      calendar,
      accounts,
      url,
    );
  const repo = new LifeOpsRepository(host.runtime);
  const message = {
    externalId: owner,
    threadId: owner,
    subject: "Synthetic handoff fixture",
    from: "Fixture",
    fromEmail: "fixture@example.test",
    replyTo: null,
    to: [],
    cc: [],
    snippet: "Fixture",
    receivedAt: "2026-09-01T00:00:00Z",
    isUnread: true,
    isImportant: false,
    likelyReplyNeeded: false,
    triageScore: 0,
    triageReason: "Fixture",
    labels: [],
    htmlLink: null,
    metadata: {},
  };
  const previousMessage = lifeOpsGmailMessageFromGoogle({
    agentId: host.runtime.agentId,
    grant: previousGrant,
    message,
    syncedAt: "2026-09-01T00:00:00Z",
  });
  const replacementMessage = lifeOpsGmailMessageFromGoogle({
    agentId: host.runtime.agentId,
    grant: f.grant,
    message,
    syncedAt: "2026-09-01T00:00:00Z",
  });
  await repo.upsertGmailMessage(previousMessage);
  await repo.upsertGmailMessage(replacementMessage);
  const previousSnapshot = await repo.getGmailMessage(
    host.runtime.agentId,
    "google",
    previousMessage.id,
  );
  const replacementSnapshot = await repo.getGmailMessage(
    host.runtime.agentId,
    "google",
    replacementMessage.id,
  );
  if (!previousSnapshot || !replacementSnapshot)
    throw new Error("Fixture messages were not persisted");
  const read = () =>
    repo.listGmailMessages(
      host.runtime.agentId,
      "google",
      { grantId: previousGrant.id },
      "owner",
    );
  return {
    f,
    calendar,
    store,
    state,
    statuses,
    accounts,
    service,
    repo,
    read,
    previousMessage,
    replacementMessage,
    previousSnapshot,
    replacementSnapshot,
    disconnect,
    disconnectCalls,
    previousGrant,
  };
}

describe("handoff imported-data disposition", () => {
  it("recovers after deletion but before checkpoint, retaining replacement mail and paused controls", async () => {
    const p = await prepared("remove-owner");
    const control = await p.calendar.getLinkedCalendarControl();
    await executeRawSql(
      host.runtime,
      "ALTER TABLE app_lifeops.life_account_handoffs ADD CONSTRAINT reject_disposition_checkpoint CHECK (NOT (receipt_json::jsonb ? 'importedDataDisposition'))",
    );
    try {
      await expect(
        p.service().apply(p.state.operationId, p.state.revision),
      ).rejects.toThrow();
      expect(await p.read()).toEqual([]);
      expect(await p.store.read(p.state.operationId)).toEqual(p.state);
    } finally {
      await executeRawSql(
        host.runtime,
        "ALTER TABLE app_lifeops.life_account_handoffs DROP CONSTRAINT reject_disposition_checkpoint",
      );
    }
    const completed = await p
      .service()
      .apply(p.state.operationId, p.state.revision);
    expect(completed.phase).toBe("resuming");
    expect(completed.receipt.importedDataDisposition).toMatchObject({
      disposition: "remove_previous_account_imports",
      grantId: p.f.review.previous.grantId,
      providerMutation: false,
    });
    expect(
      await p.repo.getGmailMessage(
        host.runtime.agentId,
        "google",
        p.replacementMessage.id,
      ),
    ).toEqual(p.replacementSnapshot);
    expect(await p.calendar.getLinkedCalendarControl()).toEqual(control);
    await expect(
      p.service().apply(p.state.operationId, p.state.revision),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
  });

  it("preserves imported data when the saved decision is retain", async () => {
    const p = await prepared("retain-owner", false);
    await p.service().apply(p.state.operationId, p.state.revision);
    expect(
      await p.repo.getGmailMessage(
        host.runtime.agentId,
        "google",
        p.previousMessage.id,
      ),
    ).toEqual(p.previousSnapshot);
  });

  it("rejects changed ownership, accounts, and pause state before deletion", async () => {
    const p = await prepared("guard-owner");
    const unrelated = new AccountHandoffDataDisposition(
      host.runtime,
      "unrelated",
      p.calendar,
      p.accounts,
      new URL("http://localhost"),
    );
    await expect(
      unrelated.apply(p.state.operationId, p.state.revision),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
    p.statuses.push({
      ...p.f.status,
      grant: {
        ...p.f.grant,
        id: p.f.review.previous.grantId,
        connectorAccountId: p.f.review.previous.connectorAccountId,
      },
    });
    await expect(
      p.service().apply(p.state.operationId, p.state.revision),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
    expect(
      await p.repo.getGmailMessage(
        host.runtime.agentId,
        "google",
        p.previousMessage.id,
      ),
    ).toEqual(p.previousSnapshot);
    p.statuses.pop();
    p.f.status.connected = false;
    await expect(
      p.service().apply(p.state.operationId, p.state.revision),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
    p.f.status.connected = true;
    const control = await p.calendar.getLinkedCalendarControl();
    await p.calendar.executeLinkedCalendarControl(new URL("http://localhost"), {
      operation: "pause",
      expectedRevision: control.revision,
      idempotencyKey: "intervening-disposition-pause",
    });
    await expect(
      p.service().apply(p.state.operationId, p.state.revision),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
    expect(
      await p.repo.getGmailMessage(
        host.runtime.agentId,
        "google",
        p.previousMessage.id,
      ),
    ).toEqual(p.previousSnapshot);
    expect(await p.store.read(p.state.operationId)).toEqual(p.state);
  });
  it("does not repeat account removal after its checkpoint failed", async () => {
    const p = await prepared("disconnect-retry-owner", true, false);
    const control = await p.calendar.getLinkedCalendarControl();
    await executeRawSql(
      host.runtime,
      "ALTER TABLE app_lifeops.life_account_handoffs ADD CONSTRAINT reject_disconnect_checkpoint CHECK (NOT (receipt_json::jsonb ? 'previousDisconnected')) NOT VALID",
    );
    try {
      await expect(
        p.disconnect().apply(p.state.operationId, p.state.revision),
      ).rejects.toThrow();
      expect(p.statuses.map(({ grant }) => grant?.id)).toEqual([
        p.f.review.replacement.grantId,
      ]);
      expect(await p.store.read(p.state.operationId)).toEqual(p.state);
    } finally {
      await executeRawSql(
        host.runtime,
        "ALTER TABLE app_lifeops.life_account_handoffs DROP CONSTRAINT reject_disconnect_checkpoint",
      );
    }
    const saved = await p
      .disconnect()
      .apply(p.state.operationId, p.state.revision);
    expect(saved.phase).toBe("disposing_imports");
    expect(saved.receipt.previousDisconnected).toEqual(p.f.review.previous);
    expect(p.disconnectCalls).toEqual([
      {
        mode: "local",
        side: "owner",
        grantId: p.f.review.previous.grantId,
        purgeImportedData: false,
      },
    ]);
    expect(
      await p.repo.getGmailMessage(
        host.runtime.agentId,
        "google",
        p.previousMessage.id,
      ),
    ).toEqual(p.previousSnapshot);
    expect(await p.calendar.getLinkedCalendarControl()).toEqual(control);
  });

  it("does not remove a changed old identity or a replacement without current provider access", async () => {
    const p = await prepared("disconnect-guard-owner", true, false);
    p.previousGrant.identityEmail = "unexpected@example.test";
    await expect(
      p.disconnect().apply(p.state.operationId, p.state.revision),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
    p.previousGrant.identityEmail = p.f.review.previous.email;
    p.f.status.connected = false;
    await expect(
      p.disconnect().apply(p.state.operationId, p.state.revision),
    ).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_REPLACEMENT_UNAVAILABLE",
    });
    expect(p.disconnectCalls).toEqual([]);
    expect(await p.store.read(p.state.operationId)).toEqual(p.state);
  });
});
