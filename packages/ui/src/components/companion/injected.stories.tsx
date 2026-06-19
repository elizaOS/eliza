import type { Meta, StoryObj } from "@storybook/react";
import type { CompanionInferenceNotice } from "../../config/boot-config";
import { AppBootContext } from "../../config/boot-config-react.hooks";
import {
  type AppBootConfig,
  DEFAULT_BOOT_CONFIG,
} from "../../config/boot-config-store";
import {
  CompanionGlobalOverlay,
  CompanionInferenceAlertButton,
} from "./injected";

// Mock companion components that the host app would normally inject via boot
// config. Stories render these slot-injected wrappers so we can preview shapes
// without depending on the real host bundle.

function MockAlertButton({
  notice,
  onClick,
}: {
  notice: CompanionInferenceNotice;
  onClick: () => void;
}) {
  const palette =
    notice.kind === "cloud" && notice.variant === "danger"
      ? "border-red-500 bg-red-500/10 text-red-300"
      : "border-yellow-500 bg-yellow-500/10 text-yellow-300";
  return (
    <button
      type="button"
      onClick={onClick}
      title={notice.tooltip}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${palette}`}
    >
      <span aria-hidden>!</span>
      {notice.kind === "cloud" ? "Cloud inference" : "Inference settings"}
    </button>
  );
}

function MockGlobalOverlay() {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 flex justify-center">
      <div className="rounded-md bg-black/80 px-4 py-2 text-xs text-white shadow-lg">
        Mock global companion overlay
      </div>
    </div>
  );
}

function withBootConfig(overrides: Partial<AppBootConfig>) {
  const value: AppBootConfig = { ...DEFAULT_BOOT_CONFIG, ...overrides };
  return function Decorator(Story: React.ComponentType) {
    return (
      <AppBootContext.Provider value={value}>
        <div className="p-6">
          <Story />
        </div>
      </AppBootContext.Provider>
    );
  };
}

const cloudDangerNotice: CompanionInferenceNotice = {
  kind: "cloud",
  variant: "danger",
  tooltip: "Cloud credits exhausted — local inference will be used.",
};

const cloudWarnNotice: CompanionInferenceNotice = {
  kind: "cloud",
  variant: "warn",
  tooltip: "Cloud credits low — top up to keep streaming.",
};

const settingsWarnNotice: CompanionInferenceNotice = {
  kind: "settings",
  variant: "warn",
  tooltip: "No inference provider configured. Open settings to fix.",
};

// ---------------------------------------------------------------------------
// CompanionInferenceAlertButton
// ---------------------------------------------------------------------------

const alertMeta = {
  title: "Companion/CompanionInferenceAlertButton",
  component: CompanionInferenceAlertButton,
  tags: ["autodocs"],
  argTypes: {
    onClick: { action: "clicked" },
  },
  args: {
    notice: cloudDangerNotice,
    onClick: () => {},
  },
  decorators: [
    withBootConfig({ companionInferenceAlertButton: MockAlertButton }),
  ],
} satisfies Meta<typeof CompanionInferenceAlertButton>;

export default alertMeta;
type AlertStory = StoryObj<typeof alertMeta>;

export const CloudDanger: AlertStory = {
  args: { notice: cloudDangerNotice },
};

export const CloudWarn: AlertStory = {
  args: { notice: cloudWarnNotice },
};

export const SettingsWarn: AlertStory = {
  args: { notice: settingsWarnNotice },
};

export const NoHostComponent: AlertStory = {
  name: "No Host Component (renders null)",
  args: { notice: cloudWarnNotice },
  decorators: [withBootConfig({ companionInferenceAlertButton: undefined })],
};

// ---------------------------------------------------------------------------
// CompanionGlobalOverlay
// ---------------------------------------------------------------------------

export const GlobalOverlay: StoryObj = {
  name: "CompanionGlobalOverlay / Rendered",
  render: () => <CompanionGlobalOverlay />,
  decorators: [withBootConfig({ companionGlobalOverlay: MockGlobalOverlay })],
};

export const GlobalOverlayMissing: StoryObj = {
  name: "CompanionGlobalOverlay / No Host Component",
  render: () => (
    <div className="text-xs text-muted-foreground">
      CompanionGlobalOverlay renders nothing when the host has not injected one.
    </div>
  ),
  decorators: [withBootConfig({ companionGlobalOverlay: undefined })],
};
