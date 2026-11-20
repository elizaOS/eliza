/** Replays the replies of quint/SendConsentReply.qnt through the draft send action. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, type Memory, type UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { describe, expect, it } from "vitest";
import { BaseMessageAdapter } from "../adapters/base.ts";
import { pendingSendDraft } from "../send-consent.ts";
import { getDefaultTriageService } from "../triage-service.ts";
import type { DraftRequest } from "../types.ts";
import { sendDraftAction } from "./sendDraft.ts";

/** One reply of the model: "yes" and at most one more word. */
interface ModelReply {
  extra: number;
  capital: boolean;
  comma: boolean;
  mark: number;
}

/** One preview, its first answer and an optional later reply. */
interface ModelCase {
  replies: Array<{ reply: ModelReply; outcome: number; sends: number }>;
}

const EXTRA_WORDS = ["", "please", "later"] as const;
const MARKS = ["", ".", "!"] as const;
const OUTCOMES = ["none", "sent", "cancelled"] as const;

/** "Yes, please." is extra 1 with a capital letter, a comma and mark 1. */
function render(reply: ModelReply): string {
  const yes = reply.capital ? "Yes" : "yes";
  const extra =
    reply.extra === 0
      ? ""
      : `${reply.comma ? "," : ""} ${EXTRA_WORDS[reply.extra]}`;
  return `${yes}${extra}${MARKS[reply.mark]}`;
}

const reply = (
  extra: number,
  capital: boolean,
  comma: boolean,
  mark: number,
): ModelReply => ({ extra, capital, comma, mark });

// Without generated cases, each first word replays the same written forms.
const DEFAULT_CASES: ModelCase[] = [
  { replies: [{ reply: reply(0, false, false, 0), outcome: 1, sends: 1 }] },
  { replies: [{ reply: reply(0, true, false, 2), outcome: 1, sends: 1 }] },
  { replies: [{ reply: reply(1, false, false, 0), outcome: 1, sends: 1 }] },
  { replies: [{ reply: reply(1, true, true, 1), outcome: 1, sends: 1 }] },
  { replies: [{ reply: reply(1, false, true, 2), outcome: 1, sends: 1 }] },
  { replies: [{ reply: reply(2, true, true, 1), outcome: 2, sends: 0 }] },
  {
    replies: [
      { reply: reply(2, false, false, 0), outcome: 2, sends: 0 },
      { reply: reply(1, true, true, 1), outcome: 2, sends: 0 },
    ],
  },
  {
    replies: [
      { reply: reply(1, true, true, 1), outcome: 1, sends: 1 },
      { reply: reply(0, false, false, 0), outcome: 1, sends: 1 },
    ],
  },
];
const casesFile = process.env.ELIZA_SEND_CONSENT_REPLY_MODEL_CASES;
const cases: ModelCase[] = casesFile
  ? JSON.parse(readFileSync(casesFile, "utf8"))
  : DEFAULT_CASES;

/** What the send action did with one reply. */
function observed(result: unknown): string {
  const value = (result ?? {}) as {
    success?: boolean;
    text?: string;
    data?: { requiresConfirmation?: boolean };
  };
  if (value.success && value.text === "Sent it.") return "sent";
  if (
    value.success === false &&
    value.text ===
      "Nothing was sent. Preview the draft again before confirming."
  )
    return "cancelled";
  if (value.success && value.data?.requiresConfirmation)
    return "previewed again";
  return `unexpected: ${JSON.stringify(value)}`;
}

describe("send consent reply model", () => {
  it.each(
    EXTRA_WORDS.map((word, extra) => [word || "nothing", extra] as const),
  )(
    "replays the send consent reply model when yes is followed by %s",
    async (_word, extra) => {
      const own = cases.filter((item) => item.replies[0].reply.extra === extra);
      expect(own.length).toBeGreaterThan(0);
      const directory = await mkdtemp(join(tmpdir(), "send-consent-model-"));
      const runtime = new AgentRuntime({
        agentId: randomUUID() as UUID,
        character: { name: "Send consent replies", bio: [] },
        logLevel: "fatal",
      });
      runtime.registerDatabaseAdapter(
        SQLiteDatabaseAdapter.create(
          join(directory, "agent.sqlite"),
          runtime.agentId,
        ),
      );
      await runtime.init();
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
      const actor = randomUUID() as UUID;
      let timestamp = Date.now() - 60_000;
      try {
        for (const item of own) {
          // Each case is its own conversation, so its consent stands alone.
          const room = randomUUID() as UUID;
          const turn = (text: string): Memory => ({
            id: randomUUID() as UUID,
            agentId: runtime.agentId,
            entityId: actor,
            roomId: room,
            createdAt: ++timestamp,
            content: { text },
          });
          const request = turn("Send Alice the notes");
          const draft = await service.draftFollowup(runtime, {
            requester: request,
            source: "telegram",
            to: [{ identifier: "alice" }],
            body: "Notes for Alice",
          });
          // The planner names the previewed draft (data.draftId is planner-facing).
          const options = { parameters: { draftId: draft.draftId } };
          const preview = await sendDraftAction.handler(
            runtime,
            request,
            undefined,
            options,
          );
          expect(observed(preview)).toBe("previewed again");
          expect(
            preview && typeof preview === "object" ? preview.text : "",
          ).toContain("want me to send it?");
          for (const [index, step] of item.replies.entries()) {
            const text = render(step.reply);
            const answer = turn(text);
            const recovered = await pendingSendDraft(runtime, answer);
            const result = await sendDraftAction.handler(
              runtime,
              answer,
              undefined,
              options,
            );
            expect({
              text,
              outcome: observed(result),
              recovered,
              sends: sent.filter((id) => id === draft.draftId).length,
            }).toEqual({
              text,
              outcome: index === 0 ? OUTCOMES[step.outcome] : "previewed again",
              // Only the answer that sends the draft finds the reviewed draft.
              recovered:
                index === 0 && step.outcome === 1 ? draft.draftId : null,
              sends: step.sends,
            });
          }
        }
      } finally {
        await runtime.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
