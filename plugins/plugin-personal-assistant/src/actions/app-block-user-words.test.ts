/**
 * APP_BLOCK package inference must read the user's words, not the envelope.
 *
 * handleBlock() falls back to deterministic package-name inference from the
 * planner intent plus the raw message text when no explicit packageNames or
 * appTokens were supplied. It scanned the raw rendered text, so under
 * document augmentation a recalled document naming an installed app (here
 * YouTube) made inference select that app even when the user's own request
 * named a different app (Instagram). The same applies to a connector
 * envelope prefixing the user's words: the envelope's own app mention was
 * treated as part of the request. After the fix, the inference input reads
 * getUserMessageText, which prefers currentMessageText and strips the
 * document-augmentation wrapper.
 *
 * The LLM planning path reads the same user words: its "Current request"
 * section previously used the raw message text, so a document fragment
 * naming an app reached the planner even after the deterministic inference
 * gate was fixed. It now also reads getUserMessageText, matching
 * website-block.ts.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const blocker = vi.hoisted(() => ({
  startAppBlock: vi.fn(),
  installedApps: [] as Array<{ packageName: string; displayName: string }>,
}));

vi.mock("@elizaos/plugin-blocker/services/app-blocker/index", () => ({
  APP_BLOCKER_ACCESS_ERROR: "App blocking is owner-only.",
  getAppBlockerAccess: vi.fn(async () => ({ allowed: true })),
  getAppBlockerStatus: vi.fn(async () => ({
    available: true,
    active: false,
    platform: "android",
    engine: "usage-stats-overlay",
    blockedCount: 0,
    blockedPackageNames: [],
    endsAt: null,
    permissionStatus: "granted",
  })),
  getInstalledApps: vi.fn(async () => blocker.installedApps),
  startAppBlock: blocker.startAppBlock,
  stopAppBlock: vi.fn(),
}));

import { runAppBlockHandler } from "./app-block";

const INSTALLED_APPS = [
  { packageName: "com.google.android.youtube", displayName: "YouTube" },
  { packageName: "com.google.android.apps.tachyon", displayName: "Meet" },
  { packageName: "com.instagram.android", displayName: "Instagram" },
  {
    packageName: "com.google.android.apps.chromecast.app",
    displayName: "Google Home",
  },
  { packageName: "com.twitter.android", displayName: "X" },
  { packageName: "com.kakao.talk", displayName: "카카오톡" },
];

const USER_WORDS = "block instagram until I finish my homework";
const INSTAGRAM = "com.instagram.android";

function makeRuntime() {
  return {
    agentId: "agent-1",
    useModel: vi.fn(async () => "{}"),
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime & { useModel: ReturnType<typeof vi.fn> };
}

async function blockedPackagesFor(
  content: Record<string, unknown>,
  intent: string,
): Promise<string[]> {
  const runtime = makeRuntime();
  const message = {
    entityId: "owner-1",
    roomId: "room-1",
    content,
  } as unknown as Memory;
  const result = await runAppBlockHandler(runtime, message, undefined, {
    parameters: { action: "block", intent },
  });
  expect(result.success).toBe(true);
  expect(runtime.useModel).not.toHaveBeenCalled();
  expect(blocker.startAppBlock).toHaveBeenCalledTimes(1);
  return blocker.startAppBlock.mock.calls[0][0].packageNames;
}

const AUGMENTED_TEXT = [
  "Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
  "If the answer appears verbatim in the contextual documents, repeat it exactly.",
  "",
  "<contextual_documents>",
  '<source title="media notes" similarity="0.900">',
  "I watched YouTube all afternoon instead of studying.",
  "</source>",
  "</contextual_documents>",
  "",
  "<user_request>",
  USER_WORDS,
  "</user_request>",
].join("\n");

describe("runAppBlockHandler package inference user words", () => {
  beforeEach(() => {
    blocker.installedApps = INSTALLED_APPS;
    blocker.startAppBlock.mockReset();
    blocker.startAppBlock.mockImplementation(
      async (opts: { packageNames?: string[] }) => ({
        success: true,
        endsAt: null,
        blockedCount: opts.packageNames?.length ?? 0,
      }),
    );
  });

  it("does not block a document-mentioned app when the user named another app", async () => {
    await expect(
      blockedPackagesFor({ text: AUGMENTED_TEXT }, USER_WORDS),
    ).resolves.toEqual([INSTAGRAM]);
  });

  it("does not block an envelope-mentioned app when the user named another app", async () => {
    await expect(
      blockedPackagesFor(
        {
          text: "[Discord #general] @someone (2026-11-02 09:00): block YouTube during my meeting",
          currentMessageText: USER_WORDS,
        },
        USER_WORDS,
      ),
    ).resolves.toEqual([INSTAGRAM]);
  });

  it("still blocks the named app for a plain request", async () => {
    await expect(
      blockedPackagesFor(
        { text: "block YouTube during my meeting" },
        "block YouTube during my meeting",
      ),
    ).resolves.toEqual(["com.google.android.youtube"]);
  });

  it("still blocks the named app for a plain instagram request", async () => {
    await expect(
      blockedPackagesFor({ text: USER_WORDS }, USER_WORDS),
    ).resolves.toEqual([INSTAGRAM]);
  });

  it("does not send a document fragment to the LLM planner's current request", async () => {
    const runtime = makeRuntime();
    let capturedPrompt = "";
    runtime.useModel.mockImplementation(
      async (_type: unknown, opts: { prompt?: string }) => {
        capturedPrompt = opts.prompt ?? "";
        return JSON.stringify({
          shouldAct: false,
          response: "Tell me which installed apps to block.",
          packageNames: [],
          durationMinutes: null,
        });
      },
    );
    const message = {
      entityId: "owner-1",
      roomId: "room-1",
      content: {
        text: [
          "Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
          "",
          "<contextual_documents>",
          '<source title="focus notes" similarity="0.900">',
          "block YouTube during deep work",
          "</source>",
          "</contextual_documents>",
          "",
          "<user_request>",
          "Start a focus block for me.",
          "</user_request>",
        ].join("\n"),
      },
    } as unknown as Memory;
    const result = await runAppBlockHandler(runtime, message, undefined, {
      parameters: { action: "block" },
    });
    expect(runtime.useModel).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({ error: "PLANNER_SHOULDACT_FALSE" });
    expect(capturedPrompt).toContain("Start a focus block for me.");
    expect(capturedPrompt).not.toContain("block YouTube during deep work");
    expect(capturedPrompt).not.toContain(
      "Answer the user request using the contextual documents",
    );
  });
});
