import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, type Memory, type UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing";
import { expect, it } from "vitest";
import { BaseMessageAdapter } from "../adapters/base.ts";
import { draftConsentDigest, requireSendConsent } from "../send-consent.ts";
import { getDefaultTriageService } from "../triage-service.ts";
import type { DraftRequest } from "../types.ts";
import { sendDraftAction } from "./sendDraft.ts";

it("binds actual draft sending to a later user turn and consumes consent once durably", async () => {
  const directory = await mkdtemp(join(tmpdir(), "message-consent-"));
  const runtime = new AgentRuntime({
    agentId: randomUUID() as UUID,
    character: { name: "Consent test", bio: [] },
    logLevel: "fatal",
  });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(
      join(directory, "agent.sqlite"),
      runtime.agentId,
    ),
  );
  await runtime.init();
  const actor = randomUUID() as UUID,
    room = randomUUID() as UUID;
  let timestamp = Date.now() - 10000;
  const turn = (text: string): Memory => ({
    id: randomUUID() as UUID,
    agentId: runtime.agentId,
    entityId: actor,
    roomId: room,
    createdAt: ++timestamp,
    content: { text },
  });
  const sent: string[] = [];
  class Transport extends BaseMessageAdapter {
    readonly source = "telegram" as const;
    isAvailable() {
      return true;
    }
    protected async createDraftImpl(
      _runtime: AgentRuntime,
      draft: DraftRequest,
    ) {
      return { draftId: randomUUID(), preview: draft.body };
    }
    protected async sendDraftImpl(_runtime: AgentRuntime, draftId: string) {
      sent.push(draftId);
      return { externalId: `accepted-${draftId}` };
    }
  }
  const service = getDefaultTriageService();
  service.register(new Transport());
  try {
    const draft = await service.draftFollowup(runtime, {
      source: "telegram",
      to: [{ identifier: "actual-id", displayName: "Alice" }],
      body: "Original body",
    });
    const first = turn("Send this");
    const options = { parameters: { draftId: draft.draftId, confirmed: true } };
    const preview = await sendDraftAction.handler(
      runtime,
      first,
      undefined,
      options,
    );
    expect(preview).toMatchObject({ data: { requiresConfirmation: true } });
    expect(
      preview && typeof preview === "object" ? preview.text : "",
    ).toContain("actual-id");
    await sendDraftAction.handler(runtime, first, undefined, options);
    expect(sent).toEqual([]);
    const yes = turn("yes");
    const outcomes = await Promise.all([
      sendDraftAction.handler(runtime, yes, undefined, options),
      sendDraftAction.handler(runtime, yes, undefined, options),
    ]);
    expect(sent).toEqual([draft.draftId]);
    expect(
      outcomes.filter(
        (outcome) => outcome && typeof outcome === "object" && outcome.success,
      ),
    ).toHaveLength(1);
    await sendDraftAction.handler(runtime, yes, undefined, options);
    expect(sent).toHaveLength(1);

    for (const text of [
      "yes, but change the recipient",
      "yes?",
      "do not send",
      "yes, don't send yet",
    ]) {
      const digest = randomUUID();
      expect(await requireSendConsent(runtime, turn("preview"), digest)).toBe(
        "pending",
      );
      expect(await requireSendConsent(runtime, turn(text), digest)).toBe(
        "cancelled",
      );
    }
    const digest = randomUUID();
    await requireSendConsent(runtime, turn("preview"), digest);
    expect(
      await requireSendConsent(
        runtime,
        { ...turn("yes"), roomId: randomUUID() as UUID },
        digest,
      ),
    ).toBe("pending");
    expect(
      await requireSendConsent(
        runtime,
        { ...turn("yes"), entityId: randomUUID() as UUID },
        digest,
      ),
    ).toBe("pending");
    expect(await requireSendConsent(runtime, turn("yes"), "changed-body")).toBe(
      "pending",
    );
    const staleDigest = draftConsentDigest(draft);
    service.getStore().saveDraft({ ...draft, body: "Changed body" });
    await expect(
      service.sendDraft(runtime, draft.draftId, staleDigest),
    ).rejects.toMatchObject({ code: "MESSAGE_DRAFT_CONSENT_DIGEST_MISMATCH" });
    expect(sent).toHaveLength(1);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
