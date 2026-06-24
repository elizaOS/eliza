import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useRef, useState } from "react";

import type { ViewEntry } from "../../hooks/view-catalog";
import { MockAppProvider } from "../../storybook/mock-providers";
import {
  HOME_WIDGET_MOCK_PLUGINS,
  installHomeWidgetFetchMock,
  seedHomeWidgetNotifications,
} from "../../widgets/__fixtures__/home-widget-mock-data";
import { ShaderBackground } from "../../backgrounds/ShaderBackground";
import { Springboard } from "../pages/Springboard";
import { HomeScreen } from "./HomeScreen";
import { HomeSpringboardSurface } from "./HomeSpringboardSurface";
import type { HomeSpringboardPage } from "./home-springboard-events";

// The consolidated /chat home (#9143): the REAL HomeScreen mounting the REAL
// unified home-slot WidgetHost, paired with the Springboard launcher as the two
// pages of HomeSpringboardSurface. The per-plugin home widgets (calendar /
// goals / finances / health / relationships / inbox) + notifications are the
// genuine widget components, fed by the shared injected mock data only — no
// stubbing of WidgetHost or the widgets themselves. The launcher page renders
// the presentational <Springboard> with a representative tile set (its
// data-fetching <SpringboardSurface> wrapper needs a live /api/views layer the
// catalog doesn't have).

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

const SPRINGBOARD_TILES: ViewEntry[] = [
  viewEntry("character", "Character", "UserRound"),
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

function HomeDashboard({
  initialPage = "home",
  seed = true,
}: {
  initialPage?: HomeSpringboardPage;
  seed?: boolean;
}) {
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
          <HomeSpringboardSurface
            initialPage={initialPage}
            home={<HomeScreen onOpenTile={() => {}} showNativeOsTiles />}
            springboard={
              <Springboard entries={SPRINGBOARD_TILES} onLaunch={() => {}} />
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
  args: { initialPage: "home", seed: true },
};

/** The adjacent Springboard launcher page of the same consolidated surface. */
export const SpringboardPage: Story = {
  args: { initialPage: "springboard", seed: true },
};

/** No attention-worthy data: every widget self-hides, leaving the clean home. */
export const Empty: Story = {
  args: { initialPage: "home", seed: false },
};
