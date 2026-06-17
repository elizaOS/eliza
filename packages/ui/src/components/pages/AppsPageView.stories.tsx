import type { Meta, StoryObj } from "@storybook/react";
import { mockApp } from "../../storybook/mock-providers.helpers";
import { AppsPageView } from "./AppsPageView";

// Placeholder renderers stand in for the real AppsView / GameView surfaces,
// which fetch from the (backend-less) API client. The component accepts both
// as injectable props, so stories render deterministic content.
const AppsViewStub = () => (
  <div className="rounded-lg border border-white/10 bg-white/5 p-8 text-center">
    <h2 className="text-lg font-semibold text-emerald-400">App browser</h2>
    <p className="mt-2 text-sm text-white/60">
      Installed apps and games would render here.
    </p>
  </div>
);

const GameViewStub = () => (
  <div className="flex h-64 items-center justify-center rounded-lg border border-emerald-500/40 bg-emerald-500/10">
    <span className="text-lg font-semibold text-emerald-300">
      Full-screen game mode
    </span>
  </div>
);

const sampleRun = {
  runId: "run-1",
  appName: "Asteroids",
};

const meta = {
  title: "Pages/AppsPageView",
  component: AppsPageView,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    appsView: AppsViewStub,
    gameView: GameViewStub,
  },
  decorators: [
    mockApp({ appsSubTab: "browse", activeGameRunId: "", appRuns: [] }),
  ],
} satisfies Meta<typeof AppsPageView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const InModal: Story = {
  args: { inModal: true },
};

export const GameActive: Story = {
  decorators: [
    mockApp({
      appsSubTab: "games",
      activeGameRunId: "run-1",
      // biome-ignore lint/suspicious/noExplicitAny: minimal run fixture for story
      appRuns: [sampleRun] as any,
    }),
  ],
};
