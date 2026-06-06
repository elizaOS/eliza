import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import type { RegistryAppInfo } from "../../api";
import type { AppContextValue } from "../../state/types";
import { AppContext } from "../../state/useApp";
import { AppsCatalogGrid } from "./AppsCatalogGrid";

function makeApp(overrides: Partial<RegistryAppInfo>): RegistryAppInfo {
  return {
    name: overrides.name ?? "app",
    displayName: overrides.displayName ?? overrides.name ?? "App",
    description: "A friendly placeholder app for the catalog.",
    category: "utility",
    launchType: "iframe",
    launchUrl: "https://example.com",
    icon: null,
    heroImage:
      overrides.heroImage ??
      `https://placehold.co/640x480/png?text=${encodeURIComponent(
        overrides.displayName ?? overrides.name ?? "App",
      )}`,
    capabilities: [],
    stars: 0,
    repository: "",
    latestVersion: "1.0.0",
    supports: {} as RegistryAppInfo["supports"],
    npm: {} as RegistryAppInfo["npm"],
    ...overrides,
  };
}

const sampleApps: RegistryAppInfo[] = [
  makeApp({
    name: "wallet",
    displayName: "Wallet",
    category: "finance",
    firstParty: true,
    builtIn: true,
  }),
  makeApp({
    name: "arcade",
    displayName: "Arcade",
    category: "game",
    firstParty: true,
  }),
  makeApp({
    name: "synth-studio",
    displayName: "Synth Studio",
    category: "game",
    thirdParty: true,
    support: "community",
  }),
  makeApp({
    name: "devtools",
    displayName: "Devtools",
    category: "utility",
    firstParty: true,
    builtIn: true,
  }),
  makeApp({
    name: "log-viewer",
    displayName: "Log Viewer",
    category: "utility",
    thirdParty: true,
    support: "community",
  }),
  makeApp({
    name: "notes",
    displayName: "Notes",
    category: "utility",
    firstParty: true,
  }),
  makeApp({
    name: "explorer",
    displayName: "Explorer",
    category: "utility",
    thirdParty: true,
  }),
];

const mockAppContext = new Proxy({} as AppContextValue, {
  get(_, prop) {
    if (prop === "t") return (k: string) => k;
    if (prop === "uiLanguage") return "en";
    return () => {};
  },
});

function AppContextDecorator({ children }: { children: ReactNode }) {
  return (
    <AppContext.Provider value={mockAppContext}>{children}</AppContext.Provider>
  );
}

const meta = {
  title: "Apps/AppsCatalogGrid",
  component: AppsCatalogGrid,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <AppContextDecorator>
        <div style={{ minWidth: 960 }}>
          <Story />
        </div>
      </AppContextDecorator>
    ),
  ],
  args: {
    activeAppNames: new Set<string>(),
    favoriteAppNames: new Set<string>(),
    error: null,
    loading: false,
    searchQuery: "",
    visibleApps: sampleApps,
    onLaunch: () => {},
    onToggleFavorite: () => {},
  },
} satisfies Meta<typeof AppsCatalogGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithFavoritesAndActive: Story = {
  args: {
    activeAppNames: new Set(["wallet"]),
    favoriteAppNames: new Set(["wallet", "arcade"]),
  },
};

export const Loading: Story = {
  args: {
    loading: true,
    visibleApps: [],
  },
};

export const Empty: Story = {
  args: {
    visibleApps: [],
  },
};

export const EmptySearch: Story = {
  args: {
    visibleApps: [],
    searchQuery: "no-match",
  },
};

export const ErrorState: Story = {
  args: {
    error: "Could not load the apps catalog.",
    visibleApps: [],
    onRetry: () => {},
  },
};
