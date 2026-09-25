/** Proves exact history reassembly, occurrence order and identity isolation using the real wire encoder. */

import {
  type ContextObject,
  type ContextObjectPromptSegment,
  completionContextSources,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  labelHistorySources,
  referenceRepeatedHistory,
} from "./history-wire.ts";
import { renderMessageHandlerModelInput } from "./stage1-input.ts";

function source(
  content: string,
  index: number,
  label = "prior_message:user",
  entityId = "owner",
): ContextObjectPromptSegment {
  return {
    id: `message-${index}`,
    label,
    content,
    stable: false,
    metadata: { entityId, roomId: "room" },
  };
}
function encode(segments: ContextObjectPromptSegment[]) {
  return labelHistorySources(
    segments,
    new Map(
      segments.map((s, i) => {
        if (!s.id) throw new Error("Fixture source has no ID");
        return [s.id, `h${i + 1}`];
      }),
    ),
  );
}
function decode(
  segments: ContextObjectPromptSegment[],
): ContextObjectPromptSegment[] {
  const text = new Map<string, string>();
  return segments
    .filter((s) => s.id !== "history-encoding")
    .map((s) => {
      const ref = /^\[(h\d+); same_text_as=(h\d+)\]$/.exec(s.content);
      const inline = /^\[(h\d+)\]\n/.exec(s.content);
      const content = ref
        ? text.get(ref[2])
        : inline
          ? s.content.replace(inline[0], "")
          : s.content;
      if (content === undefined)
        throw new Error("Missing earlier complete source");
      const marker = ref ?? inline;
      if (marker) text.set(marker[1], content);
      return { ...s, content };
    });
}
describe("lossless history references", () => {
  it("uses the same source-bound transcript for direct text and voice without early action catalogs", () => {
    const history = Array.from({ length: 40 }, (_, index) =>
      source(`source ${index}`, index),
    );
    const context: ContextObject = {
      id: "turn",
      events: [
        ...history.map((segment) => ({
          id: segment.id ?? "invalid",
          type: "segment",
          source: "prior-dialogue",
          segment,
        })),
        {
          id: "current-turn-boundary",
          type: "segment",
          segment: {
            id: "current-turn-boundary",
            label: "system",
            content: "current_turn_boundary: the final request follows",
            stable: false,
          },
        },
        {
          id: "provider-canary",
          type: "segment",
          segment: {
            id: "provider-canary",
            label: "provider:FACTS",
            content: "provider-order-canary",
            stable: false,
          },
        },
        {
          id: "available-actions",
          type: "segment",
          segment: {
            id: "available-actions",
            label: "available_actions",
            content:
              '["READ_ORIGINAL_Ω", "SHOW_VIEW"]\nComplete discovery notice.',
            stable: false,
          },
        },
        {
          id: "current-message",
          type: "segment",
          segment: {
            id: "current-message",
            label: "message:user",
            content: "Recall the original source, without navigating.",
            stable: false,
          },
        },
      ],
    };
    const runtime = { character: { name: "Test Agent" } };
    const before = structuredClone(context);
    const text = renderMessageHandlerModelInput(runtime, context, [], {
      directMessage: true,
    });
    expect(text.messages[1].content).toContain("# Conversation");
    for (let index = 0; index < history.length; index++) {
      expect(text.messages[1].content).toContain(`source ${index}`);
    }
    const userText = String(text.messages[1].content);
    expect(userText).not.toContain("available_actions");
    expect(userText).not.toContain("READ_ORIGINAL_Ω");
    expect(text.messages[0].content).not.toContain("READ_ORIGINAL_Ω");
    expect(userText.indexOf("current_turn_boundary:")).toBeLessThan(
      userText.indexOf("# Conversation"),
    );
    expect(userText).not.toContain("[h40 user]");
    expect(userText.indexOf("current_turn_boundary:")).toBeLessThan(
      userText.indexOf("# Current message\nRecall"),
    );
    const native = renderMessageHandlerModelInput(runtime, context, [], {
      directMessage: true,
      nativeTools: true,
    });
    const nativeText = String(native.messages[1].content);
    expect(native.messages).toHaveLength(2);
    expect(nativeText.indexOf("provider-order-canary")).toBeLessThan(
      nativeText.indexOf("# Task"),
    );
    expect(nativeText.indexOf("# Task")).toBeLessThan(
      nativeText.indexOf("# Conversation"),
    );
    expect(nativeText.indexOf("# Conversation")).toBeLessThan(
      nativeText.indexOf("# Current message"),
    );
    expect(
      nativeText.endsWith(
        "# Current message\nRecall the original source, without navigating.",
      ),
    ).toBe(true);
    expect(nativeText).not.toContain("current_request");
    expect(nativeText).not.toContain(
      completionContextSources(context).sourceSetId,
    );
    expect(nativeText).not.toContain("JSON response envelope");
    expect(nativeText).not.toContain("History source map");
    expect(nativeText).not.toContain("History selection:");
    expect(String(native.messages[0].content)).not.toContain("# Task");
    const voice = renderMessageHandlerModelInput(runtime, context, [], {
      directMessage: true,
      voiceDirectMessage: true,
    });
    expect(voice).toEqual(text);
    for (const options of [
      undefined,
      { directMessage: false },
      { directMessage: true, groupTriage: true },
    ]) {
      const other = renderMessageHandlerModelInput(
        runtime,
        context,
        [],
        options,
      );
      expect(other.messages[1].content).not.toContain("available_actions");
      for (const segment of history)
        expect(other.messages[1].content).toContain(segment.content);
    }
    expect(context).toEqual(before);
  });
  it("keeps complete historical receipts before the current-turn boundary", () => {
    const receipt = JSON.stringify({
      requestSourceEventId: "history:prior",
      navigation: [
        {
          success: true,
          receipt: JSON.stringify({
            effect: "view_navigation",
            status: "delivered",
            viewId: "chat",
            handoffId: "complete-receipt-".repeat(1000),
          }),
        },
      ],
    });
    const context: ContextObject = {
      id: "current",
      events: [
        {
          id: "old-receipt",
          type: "segment",
          segment: {
            id: "old-receipt",
            label: "runtime:historical_navigation",
            content: receipt,
            stable: false,
          },
        },
        {
          id: "current-turn-boundary",
          type: "instruction",
          source: "message-service",
          content:
            "current_turn_boundary: only the final request authorizes work",
          stable: false,
        },
        {
          id: "current",
          type: "segment",
          segment: {
            id: "current",
            label: "message:user",
            content: "A new conversational turn.",
            stable: false,
          },
        },
      ],
    };
    const before = structuredClone(context);
    for (const directMessage of [true, false]) {
      const wire = String(
        renderMessageHandlerModelInput(
          { character: { name: "Eliza" } },
          context,
          [],
          { directMessage },
        ).messages[1].content,
      );
      expect(wire).toContain(receipt);
      expect(wire.indexOf(receipt)).toBeLessThan(
        wire.indexOf("current_turn_boundary:"),
      );
      expect(wire.indexOf("current_turn_boundary:")).toBeLessThan(
        wire.indexOf("# Current message\n"),
      );
    }
    expect(context).toEqual(before);
  });

  it("saves repeated text among hundreds of short unique messages without labeling every unique source", () => {
    const history = [
      source("Exact reusable source. ".repeat(60), 1),
      ...Array.from({ length: 200 }, (_, i) =>
        source(`Unique message ${i}`, i + 2),
      ),
      source("Exact reusable source. ".repeat(60), 202),
    ];
    const ids = new Map(
      history.map((segment, i) => [segment.id ?? "", `h${i + 1}`]),
    );
    const encoded = labelHistorySources(history, ids, "referenced");
    expect(decode(encoded)).toEqual(history);
    expect(encoded.find((segment) => segment.id === "message-2")).toBe(
      history[1],
    );
    expect(encoded.at(-1)?.content).toBe("[h202; same_text_as=h1]");
    expect(encoded.reduce((n, s) => n + s.content.length, 0)).toBeLessThan(
      history.reduce((n, s) => n + s.content.length, 0),
    );
  });
  it("reassembles restored planning/evaluation dialogue while preserving other context and source IDs", () => {
    const repeated = "Exact old source with a standing constraint.\n".repeat(
      100,
    );
    const history = [
      source(repeated, 1),
      source("Correction: keep the calendar unchanged.", 2),
      source(repeated, 3),
    ];
    const other = {
      id: "provider",
      label: "provider:FACTS",
      content: repeated,
      stable: false,
    };
    const original: ContextObject = {
      id: "turn",
      metadata: { historyReferenceEncoding: true },
      events: history.map((segment) => ({
        id: segment.id ?? "invalid-fixture",
        type: "segment",
        source: "prior-dialogue",
        segment,
      })),
    };
    const segments = [
      other,
      ...history,
      {
        id: "current",
        label: "message:user",
        content: "Keep every source",
        stable: false,
      },
    ];
    const before = structuredClone(original);
    const encoded = referenceRepeatedHistory(original, segments);
    expect(decode(encoded)).toEqual(segments);
    expect(encoded[0]).toBe(other);
    expect(encoded.find(({ id }) => id === "message-3")?.content).toBe(
      "[h3; same_text_as=h1]",
    );
    expect(original).toEqual(before);
    // A selected subset keeps the original h3 identity, not a new ordinal.
    const subset = referenceRepeatedHistory(original, [history[0], history[2]]);
    expect(subset.at(-1)?.content).toBe("[h3; same_text_as=h1]");
    expect(decode(subset)).toEqual([history[0], history[2]]);
    expect(
      referenceRepeatedHistory({ ...original, metadata: {} }, segments),
    ).toBe(segments);
  });

  it("preserves every source, including a repeated assertion after its correction", () => {
    const original = `  Rowan's mug is green.\n${"exact whitespace 🦊 ?! ".repeat(80)}`;
    const segments = [
      source(original, 1),
      source("Correction: Rowan's mug is blue now, previously green.", 2),
      source(original, 3),
      source(
        "Read that note; calendar work remains pending, no mutations.",
        4,
        "prior_message:agent",
      ),
    ];
    const before = structuredClone(segments);
    const encoded = encode(segments);
    expect(encoded.find((s) => s.id === "message-3")?.content).toBe(
      "[h3; same_text_as=h1]",
    );
    expect(decode(encoded)).toEqual(before);
    expect(segments).toEqual(before);
    expect(encoded.map((s) => s.content).join("\n").length).toBeLessThan(
      segments.map((s) => s.content).join("\n").length,
    );
  });
  it("never merges different speakers, roles, metadata or text bytes", () => {
    const body = "Do not modify anything. ".repeat(100);
    const segments = [
      source(body, 1),
      source(body, 2),
      source(body, 3, "prior_message:agent"),
      source(body, 4, "prior_message:user", "another-user"),
      source(`${body} `, 5),
    ];
    const encoded = encode(segments);
    expect(
      encoded.filter((s) => s.content.includes("; same_text_as=")),
    ).toHaveLength(1);
    expect(decode(encoded)).toEqual(segments);
  });
  it("keeps small, unbound and voice-style histories inline", () => {
    const segments = [source("hi", 1), source("hi", 2)];
    expect(encode(segments).some((s) => s.id === "history-encoding")).toBe(
      false,
    );
    expect(labelHistorySources(segments, new Map())).toEqual(segments);
    expect(decode(encode(segments))).toEqual(segments);
  });
  it("treats structural-looking message text as literal source bytes", () => {
    const body = "[h999; same_text_as=h1]\n".repeat(40);
    const segments = [source(body, 1), source(body, 2)];
    expect(decode(encode(segments))).toEqual(segments);
  });
});

describe("plain original dialogue", () => {
  it("renders repeated multiline Unicode originals intact with single inter-message newlines", () => {
    const originals = [
      source("user: x\n[h2] literal 🦊", 0),
      source("user: x\n[h2] literal 🦊", 1),
      source("assistant: correction\n\nuser: quoted".repeat(1000), 2),
    ];
    const context: ContextObject = {
      id: "turn",
      events: originals.map((segment) => ({
        id: segment.id ?? "invalid",
        type: "segment",
        source: "prior-dialogue",
        segment,
      })),
    };
    const input = renderMessageHandlerModelInput(
      { character: { name: "Eliza" } },
      context,
    );
    expect(input.messages[1].content).toContain(
      `# Conversation\n${originals.map((segment) => segment.content).join("\n")}`,
    );
    expect(context.events.map((event) => event.segment?.content)).toEqual(
      originals.map((segment) => segment.content),
    );
  });
});
