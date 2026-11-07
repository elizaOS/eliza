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

function makeRuntime() {
  return {
    agentId: "agent-1",
    useModel: vi.fn(async () => "{}"),
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime & { useModel: ReturnType<typeof vi.fn> };
}

async function blockedPackagesFor(text: string): Promise<string[]> {
  const runtime = makeRuntime();
  const message = {
    entityId: "owner-1",
    roomId: "room-1",
    content: { text },
  } as unknown as Memory;
  const result = await runAppBlockHandler(runtime, message, undefined, {
    parameters: { action: "block", intent: text },
  });
  expect(result.success).toBe(true);
  expect(runtime.useModel).not.toHaveBeenCalled();
  expect(blocker.startAppBlock).toHaveBeenCalledTimes(1);
  return blocker.startAppBlock.mock.calls[0][0].packageNames;
}

describe("runAppBlockHandler Android intent inference", () => {
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

  it.each([
    ["block YouTube during my meeting", ["com.google.android.youtube"]],
    ["block instagram until I finish my homework", ["com.instagram.android"]],
    ["block instagram for the next hour", ["com.instagram.android"]],
    ["block X for an hour", ["com.twitter.android"]],
    ["카카오톡을 한 시간 동안 차단해줘", ["com.kakao.talk"]],
    ["YouTube를 차단해줘", ["com.google.android.youtube"]],
    [
      "block Google Home and YouTube",
      ["com.google.android.youtube", "com.google.android.apps.chromecast.app"],
    ],
  ])("%s", async (text, expected) => {
    expect(await blockedPackagesFor(text)).toEqual(expected);
  });
});
