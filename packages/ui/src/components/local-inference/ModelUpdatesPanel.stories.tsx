import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { TranslationProvider } from "../../state/TranslationContext";
import {
  ModelUpdatesPanel,
  type VoiceModelInstallationView,
  type VoiceUpdatePreferencesView,
} from "./ModelUpdatesPanel";

const installations: VoiceModelInstallationView[] = [
  { id: "omnivoice", installedVersion: "1.0.0", pinned: false },
  { id: "diarizer", installedVersion: null, pinned: false },
  {
    id: "speaker-encoder",
    installedVersion: "0.9.0",
    pinned: true,
    lastError: "Checksum mismatch on last update attempt",
  },
];

const defaultPrefs: VoiceUpdatePreferencesView = {
  autoUpdateOnWifi: true,
  autoUpdateOnCellular: false,
  autoUpdateOnMetered: false,
};

function InteractivePanel({
  isOwner,
  checking,
  lastCheckedAt,
}: {
  isOwner: boolean;
  checking?: boolean;
  lastCheckedAt?: string | null;
}) {
  const [preferences, setPreferences] =
    useState<VoiceUpdatePreferencesView>(defaultPrefs);
  const [pins, setPins] = useState<Record<string, boolean>>({
    "speaker-encoder": true,
  });
  const rows = installations.map((inst) => ({
    ...inst,
    pinned: pins[inst.id] ?? inst.pinned,
  }));
  return (
    <ModelUpdatesPanel
      installations={rows}
      preferences={preferences}
      isOwner={isOwner}
      checking={checking}
      lastCheckedAt={lastCheckedAt}
      onCheckNow={() => {}}
      onUpdateNow={() => {}}
      onTogglePin={(id, pinned) => setPins((p) => ({ ...p, [id]: pinned }))}
      onSetPreferences={setPreferences}
    />
  );
}

const meta = {
  title: "LocalInference/ModelUpdatesPanel",
  component: ModelUpdatesPanel,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <TranslationProvider>
        <div className="w-[640px]">
          <Story />
        </div>
      </TranslationProvider>
    ),
  ],
} satisfies Meta<typeof ModelUpdatesPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Owner: Story = {
  render: () => (
    <InteractivePanel isOwner lastCheckedAt={new Date().toISOString()} />
  ),
};

export const NonOwner: Story = {
  render: () => (
    <InteractivePanel
      isOwner={false}
      lastCheckedAt={new Date().toISOString()}
    />
  ),
};

export const Checking: Story = {
  render: () => <InteractivePanel isOwner checking lastCheckedAt={null} />,
};

export const NeverChecked: Story = {
  render: () => <InteractivePanel isOwner lastCheckedAt={null} />,
};
