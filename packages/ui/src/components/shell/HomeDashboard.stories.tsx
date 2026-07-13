/**
 * Storybook states for the HomeDashboard shell surface across startup,
 * launcher, banner, and overlay contexts.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useRef, useState } from "react";
import { ShaderBackground } from "../../backgrounds/ShaderBackground";
import type { ViewEntry } from "../../hooks/view-catalog";
import { MockAppProvider } from "../../storybook/mock-providers";
import {
  HOME_WIDGET_MOCK_PLUGINS,
  installHomeWidgetFetchMock,
  seedHomeWidgetNotifications,
} from "../../widgets/__fixtures__/home-widget-mock-data";
import { Launcher } from "../pages/Launcher";
import { HomeScreen } from "./HomeScreen";

// The consolidated /chat home (#9143): the REAL HomeScreen mounting the REAL
// unified home-slot WidgetHost AND the pinned NotificationsHomeCenter, paired
// with the complete Launcher grid inline below notifications. The per-plugin
// home widgets (calendar / goals / finances / health / relationships / inbox)
// are the genuine widget components and the notification center reads the
// seeded notification store — no stubbing of WidgetHost or the widgets
// themselves. The launcher page renders the presentational <Launcher> with a
// representative tile set (its data-fetching <LauncherSurface> wrapper needs a
// live /api/views layer the catalog doesn't have).

function viewEntry(id: string, label: string, icon: string): ViewEntry {
  return {
    key: `view:${id}`,
    id,
    label,
    icon,
    hasHero: false,
    modality: "gui",
    state: "loaded",
    kind: "view",
    viewKind: "release",
  } as ViewEntry;
}

const LAUNCHER_TILES: ViewEntry[] = [
  viewEntry("automations", "Automations", "Clock"),
  viewEntry("wallet", "Wallet", "Wallet"),
  viewEntry("contacts", "Contacts", "UsersRound"),
  viewEntry("memories", "Memories", "BrainCircuit"),
  viewEntry("database", "Database", "Database"),
  viewEntry("documents", "Documents", "FileText"),
  viewEntry("settings", "Settings", "Settings"),
];

/**
 * Install the home-widget data BEFORE the widget subtree renders so each
 * widget's mount-time fetch + the WidgetHost's plugin resolution see populated
 * data. `useState`'s initializer runs synchronously on first render (ahead of
 * the children), and the `useEffect` cleanup restores `window.fetch` on unmount.
 */
function HomeWidgetData({
  seed,
  children,
}: {
  seed: boolean;
  children: React.ReactNode;
}) {
  const restoreRef = useRef<(() => void) | null>(null);
  useState(() => {
    if (seed) {
      seedHomeWidgetNotifications();
      restoreRef.current = installHomeWidgetFetchMock();
    }
    return null;
  });
  useEffect(() => () => restoreRef.current?.(), []);
  return <>{children}</>;
}

function HomeDashboard({ seed = true }: { seed?: boolean }) {
  return (
    <MockAppProvider
      value={{
        plugins: seed ? HOME_WIDGET_MOCK_PLUGINS : [],
        conversations: [],
      }}
    >
      <HomeWidgetData seed={seed}>
        <div className="absolute inset-0 overflow-hidden bg-[#0a0d16]">
          <ShaderBackground />
          <HomeScreen
            onOpenTile={() => {}}
            showNativeOsTiles
            apps={
              <Launcher entries={LAUNCHER_TILES} onLaunch={() => {}} embedded />
            }
          />
        </div>
      </HomeWidgetData>
    </MockAppProvider>
  );
}

const meta = {
  title: "Shell/Home Dashboard",
  component: HomeDashboard,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="relative h-[860px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof HomeDashboard>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The home page with the populated per-plugin widget cards (overdrawn balance,
 * at-risk goal, imminent calendar event, off-rhythm sleep, a pending
 * relationships merge, unread inbox threads, an urgent notification).
 */
export const HomeWithWidgets: Story = {
  args: { seed: true },
};

/** No attention-worthy data: every widget self-hides, leaving the clean home. */
export const Empty: Story = {
  args: { seed: false },
};
