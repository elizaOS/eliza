/**
 * Deterministic contract tests for Slack's canonical interaction projection.
 * The provider client is not mocked; these assert the exact Block Kit payload
 * handed to it and every semantic fallback before network dispatch.
 */

import {
  decodePreparedInteractionCallback,
  type Content,
  type InteractionBlock,
  type PreparedMessageInteraction,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { renderPreparedSlackInteraction, renderSlackInteractions } from "./interactions";

const prepared = (block: InteractionBlock): PreparedMessageInteraction => ({
  block,
  callbackData: "is1:0123456789abcdef0123456789abcdef",
  delivery: { mode: "native", reason: "preferred", limitations: [] },
  expiresAt: "2026-08-21T00:10:00.000Z",
  profileId: "profile-a",
});

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
    fields: [{ name: "name", type: "text", required: true }],
  },
  { kind: "task", threadId: "12345678", title: "Track task" },
  {
    kind: "secret",
    id: "secret-1",
    secretKind: "oauth",
    provider: "Example",
    reason: "Connect Example",
    url: "https://secure.example/connect",
  },
];

describe("Slack canonical interaction adapter", () => {
  it("has explicit safe behavior for every canonical block kind", () => {
    const outcomes = blocks.map((block) =>
      renderSlackInteractions({ text: "", interactions: [block] } as Content, {
        resolveUrl: (candidate) =>
          candidate.kind === "task"
            ? `https://app.example/task/${candidate.threadId}`
            : candidate.kind === "secret"
              ? candidate.url
              : undefined,
      }),
    );
    expect(outcomes.every((outcome) => outcome.outcome === "fallback")).toBe(true);
    expect(outcomes[2]?.text).toContain("Reply with your answer");
    expect(outcomes[4]?.text).not.toContain("oauth");
    expect(JSON.stringify(outcomes)).not.toContain("[CHOICE:");
    expect(JSON.stringify(outcomes)).not.toContain("[FORM]");
  });

  it("renders host-prepared authority with provider-valid Block Kit keys", () => {
    const out = renderPreparedSlackInteraction(prepared(blocks[0]));
    expect(out.outcome).toBe("native");
    expect(out.blocks[0]?.elements?.[0]).toMatchObject({
      action_id: "eliza_prepared_interaction_0",
    });
    const wire = out.blocks[0]?.elements?.[0]?.value;
    expect(decodePreparedInteractionCallback(wire)).toEqual({
      callbackData: "is1:0123456789abcdef0123456789abcdef",
      response: { value: "yes" },
    });
    expect(JSON.stringify(out)).not.toContain("authorization");
    expect(JSON.stringify(out)).not.toContain("effect");
  });

  it("surfaces provider overflow as actionable prose", () => {
    const options = Array.from({ length: 260 }, (_, index) => ({
      value: `value-${index}`,
      label: `Option ${index}`,
    }));
    const out = renderSlackInteractions({
      text: "",
      interactions: [{ kind: "choice", id: "large", scope: "pick", options }],
    } as Content);
    expect(out.blocks).toHaveLength(0);
    expect(out.outcome).toBe("fallback");
    expect(out.needsFreeTextReply).toBe(true);
    expect(out.text).toContain("Option 259");
  });
});
