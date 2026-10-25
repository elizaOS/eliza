import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  type IAgentRuntime,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { BaseMessageAdapter } from "../adapters/base.ts";
import {
  draftConsentDigest,
  pendingSendDraft,
  requireSendConsent,
} from "../send-consent.ts";
import { getDefaultTriageService } from "../triage-service.ts";
import type { DraftRequest } from "../types.ts";
import {
  outboundDraftOptionsFromMessage,
  sendDraftAction,
} from "./sendDraft.ts";

it("retains the requested email subject when natural-language draft fields need extraction", async () => {
  let calls = 0;
  const runtime = {
    useModel: async (_type: unknown, { prompt }: { prompt: string }) => {
      calls++;
      expect(prompt).toContain("<subject>");
      return "<response><source>gmail</source><recipient>qa@example.invalid</recipient><subject>Requested QA subject</subject><body>Exact body.</body></response>";
    },
  } as unknown as IAgentRuntime;
  const message = {
    content: {
      text: 'Email qa@example.invalid with subject "Requested QA subject" and body "Exact body."',
    },
  } as Memory;
  const extracted = await outboundDraftOptionsFromMessage(runtime, message, {
    parameters: {},
  });
  expect(extracted?.parameters).toMatchObject({
    source: "gmail",
    to: ["qa@example.invalid"],
    subject: "Requested QA subject",
    body: "Exact body.",
  });
  const structured = {
    source: "gmail",
    to: ["qa@example.invalid"],
    subject: "Structured subject",
    body: "Structured body.",
  };
  expect(
    (
      await outboundDraftOptionsFromMessage(runtime, message, {
        parameters: structured,
      })
    )?.parameters,
  ).toEqual(structured);
  expect(calls).toBe(1);
});

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
    expect(await pendingSendDraft(runtime, first)).toBeNull();
    expect(await pendingSendDraft(runtime, yes)).toBe(draft.draftId);
    expect(
      await pendingSendDraft(runtime, {
        ...yes,
        content: { text: "yes, but change the recipient" },
      }),
    ).toBeNull();
    expect(
      await pendingSendDraft(runtime, { ...yes, roomId: randomUUID() as UUID }),
    ).toBeNull();
    expect(
      await pendingSendDraft(runtime, {
        ...yes,
        entityId: randomUUID() as UUID,
      }),
    ).toBeNull();
    const outcomes = await Promise.all([
      sendDraftAction.handler(runtime, yes, undefined, {
        parameters: {
          draftId: "Original body",
          source: "gmail",
          to: ["other@example.invalid"],
          subject: "Planner replacement",
          body: "Planner replacement",
        },
      }),
      sendDraftAction.handler(runtime, yes, undefined, { parameters: {} }),
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
    const chip = { affirmations: ["inbox approve entry-1"] };
    const chipDigest = randomUUID();
    await requireSendConsent(runtime, turn("preview"), chipDigest, chip);
    expect(
      await requireSendConsent(
        runtime,
        turn("Inbox approve entry-1"),
        chipDigest,
        chip,
      ),
    ).toBe("confirmed");
    const otherChipDigest = randomUUID();
    await requireSendConsent(runtime, turn("preview"), otherChipDigest, chip);
    expect(
      await requireSendConsent(
        runtime,
        turn("inbox approve entry-2"),
        otherChipDigest,
        chip,
      ),
    ).toBe("cancelled");
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
    service
      .getStore()
      .saveDraft({ ...draft, body: "Changed body" }, runtime.agentId);
    await expect(
      service.sendDraft(runtime, draft.draftId, staleDigest),
    ).rejects.toMatchObject({ code: "MESSAGE_DRAFT_CONSENT_DIGEST_MISMATCH" });
    expect(sent).toHaveLength(1);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("a plain confirmation never sends an older armed draft after a newer draft preview", async () => {
  const directory = await mkdtemp(join(tmpdir(), "message-consent-latest-"));
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
    const first = turn("Send Alice the notes");
    const a = await service.draftFollowup(runtime, {
      requester: first,
      source: "telegram",
      to: [{ identifier: "alice" }],
      body: "Notes for Alice",
    });
    await sendDraftAction.handler(runtime, first, undefined, {
      parameters: { draftId: a.draftId },
    });
    expect(sent).toEqual([]);
    // A newer preview in the same conversation, without armed send consent.
    const second = turn("Also draft Bob a message");
    const b = await service.draftFollowup(runtime, {
      requester: second,
      source: "telegram",
      to: [{ identifier: "bob" }],
      body: "Message for Bob",
    });
    const yes = turn("yes");
    expect(await pendingSendDraft(runtime, yes)).toBeNull();
    // A stale explicit ID must not consume the older armed consent either.
    await sendDraftAction.handler(runtime, yes, undefined, {
      parameters: { draftId: a.draftId },
    });
    expect(sent).toEqual([]);
    // The planner names B; neither A nor B is sent, B is re-previewed instead.
    const outcome = await sendDraftAction.handler(runtime, yes, undefined, {
      parameters: { draftId: b.draftId },
    });
    expect(outcome).toMatchObject({ data: { requiresConfirmation: true } });
    expect(sent).toEqual([]);
    // Omitting the ID on another plain yes does not fall back to A either.
    await sendDraftAction.handler(runtime, turn("yes"), undefined, {
      parameters: {},
    });
    expect(sent).not.toContain(a.draftId);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("refuses a new outbound draft when the adapter cannot send a new message", async () => {
  class NoSendAdapter extends BaseMessageAdapter {
    readonly source = "telegram" as const;
    isAvailable() {
      return true;
    }
  }
  const service = getDefaultTriageService();
  service.register(new NoSendAdapter());

  const result = await sendDraftAction.handler(
    { agentId: randomUUID() } as never,
    { content: { text: "Send a Telegram message to Jane" } } as Memory,
    undefined,
    { parameters: { source: "telegram", to: ["Jane"], body: "I am late" } },
  );

  expect(result).toMatchObject({
    success: false,
    text: "telegram cannot send a new message from a draft: its adapter does not support sending a new message. Use action=send for a direct connector send.",
    data: { error: "DRAFT_SEND_UNSUPPORTED" },
  });
});
