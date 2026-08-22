/**
 * Deterministic contract tests for WhatsApp Cloud API interaction payloads and
 * conversational degradation. Assertions cover the exact provider objects;
 * live credentials remain a separate unavailable evidence row.
 */

import {
  decodePreparedInteractionCallback,
  type Content,
  type InteractionBlock,
  type PreparedMessageInteraction,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  renderPreparedWhatsAppInteraction,
  renderWhatsAppInteractions,
} from "./interactions";

const prepared = (block: InteractionBlock): PreparedMessageInteraction => ({
  block,
  callbackData: "is1:0123456789abcdef0123456789abcdef",
  delivery: { mode: "native", reason: "preferred", limitations: [] },
  expiresAt: "2026-08-21T00:10:00.000Z",
  profileId: "profile-a",
});

const runtime = { getSetting: () => "https://app.example" };
const blocks: InteractionBlock[] = [
  {
    kind: "choice",
    id: "choice-1",
    scope: "approve",
    options: [{ value: "yes", label: "Approve" }],
  },
  {
    kind: "followups",
    id: "followup-1",
    options: [{ kind: "reply", payload: "next", label: "Next" }],
  },
  {
    kind: "form",
    id: "form-1",
    title: "Details",
    fields: [{ name: "file", type: "file", maxBytes: 1024 }],
  },
  { kind: "task", threadId: "12345678", title: "Track task" },
  {
    kind: "secret",
    id: "secret-1",
    secretKind: "secret",
    reason: "Enter token securely",
    fields: [{ name: "token", type: "secret" }],
    url: "https://secure.example/request",
  },
];

describe("WhatsApp canonical interaction adapter", () => {
  it("uses native controls only for lossless provider-supported kinds", () => {
    const outcomes = blocks.map((block) =>
      renderWhatsAppInteractions(runtime, {
        text: "",
        interactions: [block],
      } as Content)
    );
    expect(outcomes.every((outcome) => outcome.outcome === "fallback")).toBe(true);
    expect(outcomes[2]?.text).toContain("Reply with your answer");
    expect(outcomes[3]?.text).toContain("https://app.example/orchestrator");
    expect(outcomes[4]?.text).toContain("https://secure.example/request");
    expect(JSON.stringify(outcomes[4])).not.toContain('"fields"');
  });

  it("uses a list for four through ten options and text beyond the limit", () => {
    const choice = (count: number): Content => ({
      text: "Pick one",
      interactions: [
        {
          kind: "choice",
          id: "choice",
          scope: "pick",
          options: Array.from({ length: count }, (_, index) => ({
            value: `v${index}`,
            label: `Option ${index}`,
          })),
        },
      ],
    });
    expect(
      renderPreparedWhatsAppInteraction(prepared(choice(4).interactions?.[0] as InteractionBlock))
        .interactive?.type,
    ).toBe("list");
    const overflow = renderPreparedWhatsAppInteraction(
      prepared(choice(11).interactions?.[0] as InteractionBlock),
    );
    expect(overflow.outcome).toBe("fallback");
    expect(overflow.reason).toBe("provider-limit");
    expect(overflow.text).toContain("Option 10");
  });

  it("uses only an opaque host reference plus schema-validated user input", () => {
    const out = renderPreparedWhatsAppInteraction(prepared(blocks[0]));
    const wire = out.interactive?.type === "button"
      ? out.interactive.action.buttons[0]?.reply.id
      : undefined;
    expect(decodePreparedInteractionCallback(wire)).toEqual({
      callbackData: "is1:0123456789abcdef0123456789abcdef",
      response: { value: "yes" },
    });
    expect(JSON.stringify(out)).not.toContain("authorization");
    expect(JSON.stringify(out)).not.toContain("effect");
  });
});
