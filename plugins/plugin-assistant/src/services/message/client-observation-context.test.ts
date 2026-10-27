import {
  type Content,
  type ContextEvent,
  renderContextObject,
  segmentBlock,
} from "@elizaos/core";
import { describe, expect, test } from "vitest";
import {
  CLIENT_OBSERVATION_SCOPE,
  CLIENT_OBSERVATION_SEGMENT_ID,
  CLIENT_OBSERVATION_SEGMENT_LABEL,
  projectClientObservation,
} from "./client-observation-context.ts";

const observation = {
  view: "notes",
  revision: 12,
  sensitive: false,
  timeZone: "America/New_York",
  selectedObject: {
    kind: "canonical-note",
    id: "note_8f14e45fceea167a5a36dedd4bea2543",
    revision: "3",
  },
};

/** Content as a resident phone stores it for a plain-text turn. */
function residentTurn(extra: Record<string, unknown> = {}): Content {
  return {
    text: "Add milk to this note",
    source: "client_chat",
    channelType: "DM",
    metadata: {
      uiTimeZone: "America/New_York",
      clientDevice: { context: observation },
      viewClientId: "11111111-2222-4333-8444-555555555555",
      viewDelivery: "completed-action",
      uiView: "notes",
      uiViewPath: "/notes",
      uiViewCapabilities: ["notes.local-record.v1"],
      uiViewActionNames: ["PROPOSE_DEVICE_ACTION"],
      userTextFormat: "plain-v1",
      ...extra,
    } as Content["metadata"],
  };
}

/** The current-message events context assembly emits for this content. */
function currentMessageEvents(content: Content): ContextEvent[] {
  const projected = projectClientObservation(content);
  const events: ContextEvent[] = [
    {
      id: "current",
      type: "message",
      source: "client_chat",
      message: {
        id: "current",
        role: "user",
        content: projected.content,
        metadata: { speakerName: "Owner", renderAsDialogue: true },
      },
    } as ContextEvent,
  ];
  if (projected.segment)
    events.push({
      id: CLIENT_OBSERVATION_SEGMENT_ID,
      type: "segment",
      source: "message-service",
      segment: {
        id: CLIENT_OBSERVATION_SEGMENT_ID,
        label: CLIENT_OBSERVATION_SEGMENT_LABEL,
        content: projected.segment,
        stable: false,
      },
    } as ContextEvent);
  return events;
}

function renderedText(events: ContextEvent[]): string {
  return renderContextObject({ events } as Parameters<
    typeof renderContextObject
  >[0])
    .promptSegments.map((segment) => segmentBlock(segment))
    .join("\n\n");
}

function unprojected(content: Content): ContextEvent[] {
  return [
    {
      id: "current",
      type: "message",
      source: "client_chat",
      message: {
        id: "current",
        role: "user",
        content,
        metadata: { speakerName: "Owner", renderAsDialogue: true },
      },
    } as ContextEvent,
  ];
}

describe("current-turn client observation", () => {
  test("renders the authored text as dialogue and the observation once", () => {
    const text = renderedText(currentMessageEvents(residentTurn()));
    expect(text).toContain("# Current message\nOwner: Add milk to this note");
    expect(text).toContain(`${CLIENT_OBSERVATION_SEGMENT_LABEL}:\n`);
    expect(text).toContain(CLIENT_OBSERVATION_SCOPE);
    expect(text).toContain(
      `clientDevice.context: ${JSON.stringify(observation)}`,
    );
    expect(text.split('"canonical-note"').length - 1).toBe(1);
    for (const omitted of ["plain-v1", "completed-action", "userTextFormat"])
      expect(text).not.toContain(omitted);
  });

  test("records the before and after prompt size of one resident turn", () => {
    const before = renderedText(unprojected(residentTurn()));
    const after = renderedText(currentMessageEvents(residentTurn()));
    // Before: the whole content, including transport bookkeeping, is JSON.
    expect(before.startsWith('# Current message\n{"text":')).toBe(true);
    const bytes = (value: string) => new TextEncoder().encode(value).length;
    const measurement = {
      beforeBytes: bytes(before),
      afterBytes: bytes(after),
      observationBytes: bytes(JSON.stringify(observation)),
    };
    console.info(
      `[client-observation] current message ${measurement.beforeBytes} -> ${measurement.afterBytes} bytes (observation ${measurement.observationBytes})`,
    );
    // The fixed scope sentence is added once, yet the turn still shrinks.
    expect(measurement.afterBytes).toBeLessThan(measurement.beforeBytes);
  });

  test("stored content and server metadata readers keep the exact original", () => {
    const content = residentTurn({
      agentActionMode: "direct-request-v1",
      clientDevice: {
        context: observation,
        calendarAgendaSource: {
          sourceId: "device-calendar",
          sourceRevision: "a".repeat(64),
        },
      },
    });
    const original = structuredClone(content);
    const projected = projectClientObservation(content);
    expect(content).toEqual(original);
    expect(projected.observation).toEqual(observation);
    expect(projected.content.metadata).toEqual({
      uiTimeZone: "America/New_York",
      viewClientId: "11111111-2222-4333-8444-555555555555",
      uiView: "notes",
      uiViewPath: "/notes",
      uiViewCapabilities: ["notes.local-record.v1"],
      uiViewActionNames: ["PROPOSE_DEVICE_ACTION"],
    });
  });

  test("a legacy duplicate of the same observation is omitted, a different one is kept", () => {
    const same = projectClientObservation(
      residentTurn({ alphaPhone: { context: observation } }),
    );
    expect(same.content.metadata).not.toHaveProperty("alphaPhone");
    const other = projectClientObservation(
      residentTurn({
        alphaPhone: { context: { ...observation, revision: 13 } },
      }),
    );
    expect(other.content.metadata).toHaveProperty("alphaPhone");
  });

  test("invalid or extended client metadata is left as complete evidence", () => {
    for (const context of [
      {
        ...observation,
        selectedObject: { ...observation.selectedObject, title: "Groceries" },
      },
      { providerReference: "CurrentElizaOwnedAlarmSnapshot" },
      { ...observation, view: "Not A View" },
    ]) {
      const content = residentTurn({ clientDevice: { context } });
      const projected = projectClientObservation(content);
      expect(projected.segment).toBeUndefined();
      expect(projected.content).toBe(content);
    }
    const extended = residentTurn({
      clientDevice: { context: observation, deviceName: "Pixel" },
    });
    expect(projectClientObservation(extended).content).toBe(extended);
    // An unknown transport value is not treated as bookkeeping.
    const unknownMode = projectClientObservation(
      residentTurn({ agentActionMode: "something-else" }),
    );
    expect(unknownMode.content.metadata).toHaveProperty(
      "agentActionMode",
      "something-else",
    );
  });

  test("content without metadata or observation is unchanged", () => {
    const plain: Content = { text: "hello", source: "client_chat" };
    expect(projectClientObservation(plain).content).toBe(plain);
    const noDevice: Content = { text: "hello", metadata: { uiView: "chat" } };
    expect(projectClientObservation(noDevice).content).toBe(noDevice);
  });
});
