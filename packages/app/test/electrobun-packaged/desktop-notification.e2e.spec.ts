/**
 * Packaged Electrobun desktop notification smoke (#13696).
 *
 * Drives the real packaged renderer notification store through the mock API's
 * WebSocket `agent_event` stream and verifies the Bun-side native bridge called
 * `Utils.showNotification` via canonical DesktopManager diagnostics.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentNotification } from "@elizaos/core";
import { expect, test } from "@playwright/test";
import { type MockApiServer, startMockApiServer } from "./mock-api";
import {
  type DesktopNotificationDiagnostic,
  PackagedDesktopHarness,
  resolvePackagedLauncher,
} from "./packaged-app-helpers";

function notification(
  id: string,
  priority: AgentNotification["priority"],
): AgentNotification {
  return {
    id: id as AgentNotification["id"],
    title: `Packaged notification ${id}`,
    body: `Native desktop notification body for ${id}`,
    category: "agent",
    priority,
    source: "packaged-electrobun-e2e",
    createdAt: Date.now(),
  };
}

async function waitForNativeNotification(
  harness: PackagedDesktopHarness,
  title: string,
): Promise<DesktopNotificationDiagnostic> {
  let records: DesktopNotificationDiagnostic[] = [];
  await expect
    .poll(
      async () => {
        records = await harness.readNotifications();
        return records.some((record) => record.title === title);
      },
      {
        timeout: 30_000,
        message: `Expected packaged native notification "${title}" to be recorded.`,
      },
    )
    .toBe(true);
  const record = records.find((entry) => entry.title === title);
  if (!record) {
    throw new Error(`Native notification "${title}" disappeared after poll.`);
  }
  return record;
}

function broadcastNotification(
  api: MockApiServer,
  item: AgentNotification,
  unreadCount = 1,
): void {
  api.broadcastAgentEvent({
    stream: "notification",
    payload: {
      notification: item,
      unreadCount,
    },
  });
}

test("packaged desktop notifications reach native OS bridge when backgrounded or urgent", async () => {
  test.setTimeout(1_200_000);

  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "eliza-desktop-notification-smoke-"),
  );
  const launcherPath = await resolvePackagedLauncher(
    path.join(tempRoot, "extract"),
  );
  expect(
    launcherPath,
    "Packaged Electrobun launcher is required (run the desktop build first).",
  ).toBeTruthy();

  let api: MockApiServer | null = null;
  let harness: PackagedDesktopHarness | null = null;
  try {
    api = await startMockApiServer({ firstRunComplete: true, port: 0 });
    harness = new PackagedDesktopHarness({
      tempRoot,
      launcherPath: launcherPath as string,
      apiBase: api.baseUrl,
    });
    await harness.start({
      bridgeHealthTimeoutMs: 300_000,
      shellReadyTimeoutMs: process.env.CI ? 120_000 : 90_000,
    });
    const activeHarness = harness;
    await api.waitForWebSocketClients(1, 60_000);
    await activeHarness.setMainWindowBounds({
      x: 0,
      y: 0,
      width: 1240,
      height: 860,
    });
    await activeHarness.showMainWindow();
    await activeHarness.focusMainWindow();
    await activeHarness.waitForState(
      (state) => state.shell.windowVisible,
      "Expected packaged desktop window to be visible before notification smoke.",
      30_000,
    );
    await activeHarness.clearNotifications();

    await activeHarness.closeMainWindow();
    await activeHarness.waitForState(
      (state) => !state.shell.windowVisible || !state.shell.windowFocused,
      "Expected packaged desktop window to be hidden or unfocused before background notification.",
      30_000,
    );
    const background = notification("background-normal", "normal");
    broadcastNotification(api, background, 1);
    const backgroundRecord = await waitForNativeNotification(
      activeHarness,
      background.title,
    );
    expect(backgroundRecord).toMatchObject({
      title: background.title,
      body: background.body,
      silent: false,
    });

    await activeHarness.clearNotifications();
    await activeHarness.showMainWindow();
    await activeHarness.focusMainWindow();
    await activeHarness.waitForState(
      (state) => state.shell.windowVisible && state.shell.windowFocused,
      "Expected packaged desktop window to be focused before urgent notification.",
      30_000,
    );
    // DesktopManager focus is the packaged/native contract. Chromium's
    // document.hasFocus() remains false under headless Xvfb even after the real
    // Electrobun window reports focused, so it is not a valid native readiness
    // signal and must not gate notification observation.
    const urgent = notification("focused-urgent", "urgent");
    broadcastNotification(api, urgent, 2);
    const urgentRecord = await waitForNativeNotification(
      activeHarness,
      urgent.title,
    );
    expect(urgentRecord).toMatchObject({
      title: urgent.title,
      body: urgent.body,
      silent: false,
    });
  } finally {
    await harness?.stop().catch(() => undefined);
    await api?.close().catch(() => undefined);
  }
});
