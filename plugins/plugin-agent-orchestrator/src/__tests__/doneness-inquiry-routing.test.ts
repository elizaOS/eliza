/**
 * Doneness-question routing: "is the color page done? link me" must surface
 * the TASKS history candidate — the durable task record is the ground truth
 * for completion — instead of routing to an app-catalog listing (live
 * 2026-08-21: APP+LIST_CLOUD_APPS dumped a 10-app catalog instead of
 * answering). Covers the ask shape and the deterministic routing evaluator.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { hardenIncomingUserMessage } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { donenessInquiryRoutingEvaluator } from "../evaluators/doneness-inquiry-routing.js";
import { looksLikeDonenessInquiry } from "../services/ask-shapes.js";

const ROOM = "room-1";

function runtimeWith(sessions: unknown[]): IAgentRuntime {
  return {
    getService: (name: string) =>
      name === "ACP_SERVICE" ? { listSessions: () => sessions } : null,
  } as unknown as IAgentRuntime;
}

function lane(label: string, initialTask: string) {
  return {
    id: `lane-${label}`,
    status: "completed",
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    metadata: { roomId: ROOM, label, initialTask },
  };
}

function discordMessage(raw: string): Memory {
  const message = {
    id: "msg-1",
    entityId: "user-1",
    roomId: ROOM,
    content: {
      text: `[Discord #general | test server] @e2e (Fri 08/21/2026 20:56 UTC): ${raw}`,
      currentMessageText: raw,
      source: "discord",
    },
  } as unknown as Memory;
  hardenIncomingUserMessage(message);
  return message;
}

async function route(message: Memory, sessions: unknown[]) {
  return donenessInquiryRoutingEvaluator.evaluate({
    runtime: runtimeWith(sessions),
    message,
    messageHandler: { processMessage: "RESPOND" },
  } as never);
}

describe("looksLikeDonenessInquiry", () => {
  it("matches doneness/completion questions about a deliverable", () => {
    for (const text of [
      "is the color page done? link me",
      "is the color page done",
      "did the tracker app finish?",
      "is the site live yet",
      "has the daily hue page deployed?",
      "did the app deploy?",
      "pomodoro ready yet?",
      "wheres my link",
      "where is the link",
      "whats the url",
      "link me",
    ]) {
      expect(looksLikeDonenessInquiry(text), text).toBe(true);
    }
  });

  it("stays out of build instructions and mixed status+imperative turns", () => {
    for (const text of [
      "make me a color page",
      "is it done? also make the button red",
      "deploy the color page",
      "build a pomodoro app and link me when done",
      "add a dark mode toggle to the page",
      "whats the weather like",
    ]) {
      expect(looksLikeDonenessInquiry(text), text).toBe(false);
    }
  });
});

describe("doneness-inquiry routing evaluator", () => {
  it("narrows the candidate surface to TASKS history for a room with lanes", async () => {
    const message = discordMessage("is the color page done? link me");
    expect(
      donenessInquiryRoutingEvaluator.shouldRun({ message } as never),
    ).toBe(true);
    const result = await route(message, [
      lane("daily-hue", "Build the Daily Hue color page"),
    ]);
    expect(result?.clearCandidateActions).toBe(true);
    expect(result?.addCandidateActions).toContain("TASKS_HISTORY");
    expect(result?.addCandidateActions).toContain("TASKS");
    expect(result?.addContextSlices).toContain("automation");
  });

  it("grounds a bare-name ask against known lane labels", async () => {
    const message = discordMessage("is daily hue done yet?");
    const result = await route(message, [
      lane("daily-hue", "Build the Daily Hue color page"),
    ]);
    expect(result?.clearCandidateActions).toBe(true);
    expect(result?.addCandidateActions).toContain("TASKS_HISTORY");
  });

  it("declines a bare-name ask matching no lane and naming no deliverable", async () => {
    const message = discordMessage("is dinner ready?");
    const result = await route(message, [
      lane("daily-hue", "Build the Daily Hue color page"),
    ]);
    expect(result).toBeUndefined();
  });

  it("only ADDS the history candidate when the room has no lanes on record", async () => {
    const message = discordMessage("is the color page done?");
    const result = await route(message, []);
    expect(result?.clearCandidateActions).toBeUndefined();
    expect(result?.addCandidateActions).toContain("TASKS_HISTORY");
  });

  it("does not fire for a fresh build ask that mentions doneness", () => {
    const message = discordMessage(
      "make me a pomodoro page and link me when its done",
    );
    expect(
      donenessInquiryRoutingEvaluator.shouldRun({ message } as never),
    ).toBe(false);
  });
});
