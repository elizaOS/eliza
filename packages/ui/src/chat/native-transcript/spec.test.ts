// Conformance tests for the native-transcript contract (v1): the serializer
// mirrors the DOM parser exactly, the golden fixture (decoded by the Swift and
// Kotlin renderers' own conformance checks) stays in sync with the harness
// script, and the action-protocol invariants hold. Regenerate the fixture with
// UPDATE_NATIVE_TRANSCRIPT_FIXTURE=1.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHAT_HARNESS_OPENING,
  CHAT_HARNESS_SCRIPT,
} from "../../components/chat/ChatWidgetHarness";
import {
  NATIVE_TRANSCRIPT_SCHEMA,
  serializeTranscript,
  serializeTranscriptMessage,
  type TranscriptSourceMessage,
} from "./spec";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "__fixtures__", "transcript-golden.json");

/** The full harness conversation as one transcript: opening + every scene as
 *  an assistant turn (with a user echo between), covering every widget kind. */
function harnessTranscript(): TranscriptSourceMessage[] {
  const messages: TranscriptSourceMessage[] = CHAT_HARNESS_OPENING.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
  }));
  CHAT_HARNESS_SCRIPT.forEach((scene, i) => {
    messages.push({
      id: `golden-user-${i}`,
      role: "user",
      content: `advance ${i}`,
    });
    messages.push({
      id: `golden-assistant-${i}`,
      role: "assistant",
      content: scene.content,
      ...(scene.failureKind ? { failureKind: scene.failureKind } : {}),
      ...(scene.secretRequest ? { secretRequest: scene.secretRequest } : {}),
      ...(scene.toolEvents ? { toolEvents: scene.toolEvents } : {}),
      ...(scene.reasoning ? { reasoning: scene.reasoning } : {}),
    });
  });
  return messages;
}

describe("native-transcript spec (v1)", () => {
  it("serializes every harness widget kind into typed segments", () => {
    const frame = serializeTranscript(harnessTranscript());
    expect(frame.schema).toBe(NATIVE_TRANSCRIPT_SCHEMA);
    const kinds = new Set(
      frame.messages.flatMap((m) =>
        m.segments.map((s) =>
          s.kind === "widget" ? `widget:${s.widgetKind}` : s.kind,
        ),
      ),
    );
    // The full production widget matrix must be representable — a native
    // renderer that decodes the fixture has seen every kind it must draw.
    for (const required of [
      "text",
      "code",
      "permission",
      "ui-spec",
      "widget:choice",
      "widget:followups",
      "widget:form",
      "widget:workflow",
      "widget:checklist",
      "widget:task",
      "widget:background",
    ]) {
      expect(kinds, `missing segment kind ${required}`).toContain(required);
    }
    // Side-channels survive serialization.
    expect(frame.messages.some((m) => m.toolEvents?.length)).toBe(true);
    expect(frame.messages.some((m) => m.reasoning)).toBe(true);
    expect(frame.messages.some((m) => m.failureKind)).toBe(true);
    expect(frame.messages.some((m) => m.secretRequest)).toBe(true);
  });

  it("never parses widgets out of USER text (literal-markers contract)", () => {
    const msg = serializeTranscriptMessage({
      id: "u1",
      role: "user",
      content: "[CHOICE:x id=x]\na=A\n[/CHOICE]",
    });
    expect(msg.segments).toEqual([
      { kind: "text", text: "[CHOICE:x id=x]\na=A\n[/CHOICE]" },
    ]);
  });

  it("strips hidden analysis tags from assistant segments", () => {
    const msg = serializeTranscriptMessage({
      id: "a1",
      role: "assistant",
      content: "Visible.<think>secret chain of thought</think>",
    });
    expect(JSON.stringify(msg.segments)).not.toContain("secret chain");
    expect(msg.segments[0]).toEqual({ kind: "text", text: "Visible." });
  });

  it("round-trips through JSON with no loss (bridge-serializable)", () => {
    const frame = serializeTranscript(harnessTranscript(), {
      turnStatus: { kind: "thinking" },
      streamingMessageId: "golden-assistant-0",
    });
    expect(JSON.parse(JSON.stringify(frame))).toEqual(frame);
  });

  it("golden fixture matches the current serializer output", () => {
    const frame = serializeTranscript(harnessTranscript());
    const next = `${JSON.stringify(frame, null, 2)}\n`;
    if (process.env.UPDATE_NATIVE_TRANSCRIPT_FIXTURE === "1") {
      mkdirSync(dirname(fixturePath), { recursive: true });
      writeFileSync(fixturePath, next);
    }
    const committed = readFileSync(fixturePath, "utf8");
    expect(committed, "run UPDATE_NATIVE_TRANSCRIPT_FIXTURE=1 to regen").toBe(
      next,
    );
  });
});
