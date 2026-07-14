// Fixture for the home-screen e2e: mounts the REAL HomeScreen — including the
// REAL unified home-slot WidgetHost (#9143), its per-plugin widget components,
// and the pinned dashboard notification center (NotificationsHomeCenter) — over
// the real ShaderBackground (flat orange + edge pulse). The widgets are fed by
// injected DATA only: the app-store plugins snapshot + notification store are
// seeded, and `window.fetch` is mocked, all BEFORE first render so the widgets
// resolve and populate on mount. Paired with run-home-screen-e2e.mjs.

import * as React from "react";
import { createRoot } from "react-dom/client";
import type { AgentNotification } from "@elizaos/core";

import {
  installHomeWidgetFetchMock,
  seedHomeWidgetAppStore,
  seedHomeWidgetNotifications,
} from "../../../widgets/__fixtures__/home-widget-mock-data";
import { ShaderBackground } from "../../../backgrounds/ShaderBackground";
import { LauncherSurface } from "../../pages/LauncherSurface";
import {
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
} from "../../../state/notifications/notification-store";
import { HomeLauncherSurface } from "../HomeLauncherSurface";
import { HomeScreen, type HomeTileTarget } from "../HomeScreen";

const params =
  typeof location !== "undefined"
    ? new URLSearchParams(location.search)
    : new URLSearchParams();

// Inject the home-widget data BEFORE the React tree renders so every widget's
// mount-time fetch + the WidgetHost's plugin resolution see populated data.
seedHomeWidgetAppStore();
if (params.has("notificationMotion")) {
  __resetNotificationStoreForTests();
  const now = Date.now();
  const notifications: AgentNotification[] = [
    {
      id: "notif-motion-1",
      title: "Motion one",
      body: "First folded notification",
      category: "system",
      priority: "normal",
      source: "system",
      createdAt: now,
      readAt: null,
    },
    {
      id: "notif-motion-2",
      title: "Motion two",
      body: "Second folded notification",
      category: "system",
      priority: "normal",
      source: "system",
      createdAt: now - 1_000,
      readAt: null,
    },
    {
      id: "notif-motion-3",
      title: "Motion three",
      body: "Third folded notification",
      category: "system",
      priority: "normal",
      source: "system",
      createdAt: now - 2_000,
      readAt: null,
    },
  ];
  for (const notification of notifications) {
    __ingestNotificationForTests(notification, notifications.length);
  }
} else {
  seedHomeWidgetNotifications();
}
installHomeWidgetFetchMock();
const showNativeOsTiles = params.has("native");

function Harness(): React.JSX.Element {
  return (
    <div
      data-testid="home-fixture-root"
      style={{ position: "fixed", inset: 0, overflow: "hidden" }}
    >
      <ShaderBackground />
      <HomeLauncherSurface
        home={
          <HomeScreen
            onOpenTile={(t: HomeTileTarget) =>
              console.log(`[fixture] open ${JSON.stringify(t)}`)
            }
            showNativeOsTiles={showNativeOsTiles}
          />
        }
        launcher={<LauncherSurface />}
      />
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
