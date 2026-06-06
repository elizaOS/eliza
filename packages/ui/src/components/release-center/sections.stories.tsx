import type { Meta, StoryObj } from "@storybook/react";
import { useRef } from "react";
import type { AppContextValue } from "../../state/internal";
import { AppContext } from "../../state/useApp";
import {
  BuildRuntimeSection,
  ReleaseNotesSection,
  ReleaseStatusSection,
  SessionControlsSection,
  WgpuSurfaceSection,
} from "./sections";
import type {
  AppReleaseStatus,
  DesktopBuildInfo,
  DesktopReleaseNotesWindowInfo,
  DesktopSessionSnapshot,
  DesktopUpdaterSnapshot,
  WebGpuBrowserStatus,
  WgpuTagElement,
} from "./types";

const mockApp = {
  t: (
    _key: string,
    options?: { defaultValue?: string } & Record<string, unknown>,
  ) => {
    let out = options?.defaultValue ?? _key;
    if (options) {
      for (const [k, v] of Object.entries(options)) {
        if (k === "defaultValue") continue;
        out = out.replace(`{{${k}}}`, String(v));
      }
    }
    return out;
  },
} as unknown as AppContextValue;

const withAppContext = (Story: () => JSX.Element) => (
  <AppContext.Provider value={mockApp}>
    <div className="max-w-3xl space-y-4 p-4">
      <Story />
    </div>
  </AppContext.Provider>
);

const updateStatus: AppReleaseStatus = {
  currentVersion: "1.4.2",
  latestVersion: "1.4.3",
  channel: "stable",
  lastCheckAt: Date.now() - 1000 * 60 * 15,
  updateAvailable: true,
};

const nativeUpdater: DesktopUpdaterSnapshot = {
  currentVersion: "1.4.2",
  channel: "stable",
  baseUrl: "https://releases.example.com/desktop/",
  appBundlePath: "/Applications/Eliza.app",
  canAutoUpdate: true,
  updateAvailable: true,
  updateReady: false,
  latestVersion: "1.4.3",
  lastStatus: {
    status: "downloading",
    message: "Downloading 1.4.3 (42%)",
    timestamp: Date.now() - 1000 * 60,
  },
};

const buildInfo: DesktopBuildInfo = {
  platform: "darwin",
  arch: "arm64",
  defaultRenderer: "native",
  availableRenderers: ["native", "cef"],
  bunVersion: "1.1.30",
  cefVersion: "127.0.6533.100",
};

const sessionSnapshots: Record<string, DesktopSessionSnapshot> = {
  "persist:default": {
    partition: "persist:default",
    persistent: true,
    cookieCount: 4,
    cookies: [
      { name: "sid", domain: ".example.com" },
      { name: "theme", domain: ".example.com" },
      { name: "lang", domain: ".example.com" },
      { name: "ab", domain: ".example.com" },
    ],
  },
  "persist:app-release-notes": {
    partition: "persist:app-release-notes",
    persistent: true,
    cookieCount: 0,
    cookies: [],
  },
};

const releaseNotesWindow: DesktopReleaseNotesWindowInfo = {
  url: "https://releases.example.com/releases/1.4.3",
  windowId: 7,
  webviewId: 12,
};

const webGpuStatus: WebGpuBrowserStatus = {
  available: true,
  reason: "WebGPU initialized on Chrome Beta with Apple GPU adapter.",
  renderer: "Apple M2 Pro",
  chromeBetaPath: "/Applications/Google Chrome Beta.app",
  downloadUrl: null,
};

const meta = {
  title: "ReleaseCenter/Sections",
  component: ReleaseStatusSection,
  tags: ["autodocs"],
  decorators: [withAppContext],
} satisfies Meta<typeof ReleaseStatusSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ReleaseStatus: Story = {
  args: {
    busyAction: null,
    nativeUpdater,
    updateLoading: false,
    updateStatus,
    onApplyUpdate: () => {},
    onCheckForUpdates: () => {},
    onDetach: () => {},
    onRefresh: () => {},
  },
};

export const ReleaseNotes: Story = {
  render: () => (
    <ReleaseNotesSection
      busyAction={null}
      nativeUpdater={nativeUpdater}
      releaseNotesUrl="https://releases.example.com/releases/"
      releaseNotesWindow={releaseNotesWindow}
      onOpenWindow={() => {}}
      onReleaseNotesUrlChange={() => {}}
      onResetUrl={() => {}}
    />
  ),
};

export const BuildRuntime: Story = {
  render: () => (
    <BuildRuntimeSection
      buildInfo={buildInfo}
      busyAction={null}
      dockVisible={true}
      nativeUpdater={nativeUpdater}
      onToggleDock={() => {}}
    />
  ),
};

export const SessionControls: Story = {
  render: () => (
    <SessionControlsSection
      busyAction={null}
      sessionSnapshots={sessionSnapshots}
      onClearCookies={() => {}}
      onClearSession={() => {}}
    />
  ),
};

export const WgpuSurface: Story = {
  render: () => {
    const wgpuRef = useRef<WgpuTagElement | null>(null);
    return (
      <WgpuSurfaceSection
        webGpuStatus={webGpuStatus}
        wgpuHidden={false}
        wgpuPassthrough={false}
        wgpuReady={true}
        wgpuRef={wgpuRef}
        wgpuTagAvailable={true}
        wgpuTransparent={false}
        onRunTest={() => {}}
        onToggleHidden={() => {}}
        onTogglePassthrough={() => {}}
        onToggleTransparent={() => {}}
      />
    );
  },
};
