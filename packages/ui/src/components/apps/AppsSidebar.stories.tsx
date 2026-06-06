import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { AppRunSummary, RegistryAppInfo } from "../../api";
import {
  type TranslationContextValue,
  TranslationCtx,
} from "../../state/TranslationContext.hooks";
import { AppsSidebar } from "./AppsSidebar";

const translationValue: TranslationContextValue = {
  t: (key, values) =>
    typeof values?.defaultValue === "string" ? values.defaultValue : key,
  uiLanguage: "en",
  setUiLanguage: () => {},
};

function makeApp(overrides: Partial<RegistryAppInfo>): RegistryAppInfo {
  return {
    name: overrides.name ?? "@elizaos/plugin-example",
    displayName: overrides.displayName ?? "Example",
    description: overrides.description ?? "An example app",
    category: overrides.category ?? "utility",
    launchType: "iframe",
    launchUrl: null,
    icon: null,
    heroImage: null,
    capabilities: [],
    stars: 0,
    repository: "",
    latestVersion: null,
    supports: { desktop: true, mobile: true, headless: false },
    npm: {
      name: overrides.name ?? "@elizaos/plugin-example",
      version: "1.0.0",
    },
    ...overrides,
  } as RegistryAppInfo;
}

const apps: RegistryAppInfo[] = [
  makeApp({
    name: "@elizaos/plugin-lifeops",
    displayName: "LifeOps",
    category: "utility",
  }),
  makeApp({
    name: "@elizaos/plugin-companion",
    displayName: "Companion",
    category: "game",
  }),
  makeApp({
    name: "@elizaos/plugin-clawville",
    displayName: "Clawville",
    category: "game",
  }),
  makeApp({
    name: "@elizaos/plugin-hyperliquid-app",
    displayName: "Hyperliquid",
    category: "platform",
  }),
  makeApp({
    name: "@elizaos/plugin-feed",
    displayName: "Feed",
    category: "social",
  }),
  makeApp({
    name: "@elizaos/plugin-notes",
    displayName: "Notes",
    category: "utility",
  }),
];

const runs: AppRunSummary[] = [
  {
    runId: "run-1",
    appName: "@elizaos/plugin-lifeops",
    displayName: "LifeOps",
    pluginName: "@elizaos/plugin-lifeops",
    launchType: "iframe",
    launchUrl: null,
    viewer: null,
    session: null,
    status: "running",
    summary: null,
    startedAt: "2026-06-05T09:00:00Z",
    updatedAt: "2026-06-05T09:30:00Z",
    lastHeartbeatAt: "2026-06-05T09:30:00Z",
    supportsBackground: true,
    viewerAttachment: "detached",
    health: "healthy",
  } as AppRunSummary,
];

function Decorator({ children }: { children: ReactNode }) {
  return (
    <TranslationCtx.Provider value={translationValue}>
      <div style={{ height: "600px", display: "flex" }}>{children}</div>
    </TranslationCtx.Provider>
  );
}

function Wrapper(
  props: Omit<
    React.ComponentProps<typeof AppsSidebar>,
    "collapsed" | "onCollapsedChange" | "width" | "onWidthChange"
  >,
) {
  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidth] = useState(260);
  return (
    <AppsSidebar
      {...props}
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
      width={width}
      onWidthChange={setWidth}
    />
  );
}

const meta = {
  title: "Apps/AppsSidebar",
  component: Wrapper,
  tags: ["autodocs"],
  decorators: [(Story) => <Decorator>{Story()}</Decorator>],
  args: {
    apps,
    browseApps: apps,
    runs: [],
    activeAppNames: new Set<string>(),
    favoriteAppNames: new Set<string>(),
    selectedAppName: null,
    onLaunchApp: () => {},
    onOpenRun: () => {},
  },
} satisfies Meta<typeof Wrapper>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithStarredAndActive: Story = {
  args: {
    runs,
    activeAppNames: new Set(["@elizaos/plugin-lifeops"]),
    favoriteAppNames: new Set(["@elizaos/plugin-notes"]),
    selectedAppName: "@elizaos/plugin-lifeops",
  },
};

export const Empty: Story = {
  args: {
    apps: [],
    browseApps: [],
    runs: [],
    activeAppNames: new Set<string>(),
    favoriteAppNames: new Set<string>(),
  },
};

export const SelectedItem: Story = {
  args: {
    selectedAppName: "@elizaos/plugin-companion",
  },
};
