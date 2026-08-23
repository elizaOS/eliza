/**
 * Visual states for the cloud settings primitives: grouped rows with inset
 * separators, every row control
 * (switch, select, segmented, slider, input, action button), and the modal /
 * confirm dialog compositions, all on Eliza brand tokens.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Button } from "../../ui/button";
import {
  CloudActionButton,
  CloudConfirmDialog,
  CloudInputRow,
  CloudModal,
  CloudRow,
  CloudSegmentedRow,
  CloudSelectRow,
  CloudSliderRow,
  CloudSwitchRow,
  DestructiveSecondaryButton,
  SettingsGroup,
  SettingsStack,
} from "./cloud-settings-primitives";

const meta = {
  title: "Settings/CloudPanelPrimitives",
  component: SettingsGroup,
  parameters: { layout: "padded" },
} satisfies Meta<typeof SettingsGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

function AllRowsDemo() {
  const [wake, setWake] = useState(true);
  const [quality, setQuality] = useState("balanced");
  const [tab, setTab] = useState("push");
  const [threshold, setThreshold] = useState(800);
  const [word, setWord] = useState("Hey Eliza");

  return (
    <div className="mx-auto max-w-2xl">
      <SettingsStack>
        <SettingsGroup
          title="Voice"
          footer="Rows keep agent-surface instrumentation and inset separators."
        >
          <CloudSwitchRow
            agentId="story-wake-word"
            label="Wake word"
            description="Listen for the wake word while idle."
            checked={wake}
            onCheckedChange={setWake}
          />
          <CloudInputRow
            agentId="story-wake-word-text"
            label="Word"
            value={word}
            onValueChange={setWord}
            placeholder="e.g. Hey Eliza"
            disabled={!wake}
          />
          <CloudSliderRow
            agentId="story-silence-threshold"
            label="Silence threshold"
            description="Auto-stop after this much silence."
            value={threshold}
            onValueChange={setThreshold}
            min={200}
            max={2000}
            step={100}
            unit="ms"
          />
        </SettingsGroup>

        <SettingsGroup title="Delivery">
          <CloudSelectRow
            agentId="story-quality"
            label="Model quality"
            description="Trade speed for accuracy."
            value={quality}
            onValueChange={setQuality}
            options={[
              { value: "fast", label: "Fast" },
              { value: "balanced", label: "Balanced" },
              { value: "best", label: "Best" },
            ]}
          />
          <CloudSegmentedRow
            agentId="story-notify-mode"
            label="Notifications"
            value={tab}
            onValueChange={setTab}
            options={[
              { value: "push", label: "Push" },
              { value: "digest", label: "Digest" },
              { value: "off", label: "Off" },
            ]}
          />
          <CloudActionButton
            agentId="story-test-notification"
            label="Test notification"
            description="Send a sample to this device."
            buttonLabel="Send test"
            onActivate={() => {}}
          />
          <CloudRow
            label="Danger zone"
            description="Destructive-secondary treatment stays on brand orange."
            control={
              <DestructiveSecondaryButton onClick={() => {}}>
                Disconnect
              </DestructiveSecondaryButton>
            }
          />
        </SettingsGroup>
      </SettingsStack>
    </div>
  );
}

export const AllRows: Story = {
  render: () => <AllRowsDemo />,
};

function ModalDemo() {
  const [open, setOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <div className="flex gap-3 p-8">
      <Button variant="outline" onClick={() => setOpen(true)}>
        Open modal
      </Button>
      <Button variant="outline" onClick={() => setConfirmOpen(true)}>
        Open confirm
      </Button>
      <CloudModal
        open={open}
        title="Add connector"
        description="Enter connector details."
        onClose={() => setOpen(false)}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => setOpen(false)}>
              Save
            </Button>
          </div>
        }
      >
        <p className="text-sm text-muted-foreground">Modal body content.</p>
      </CloudModal>
      <CloudConfirmDialog
        open={confirmOpen}
        title="Remove connection?"
        description="This disconnects the integration immediately."
        destructive
        confirmLabel="Remove"
        onConfirm={() => {}}
        onClose={() => setConfirmOpen(false)}
      />
    </div>
  );
}

export const Modals: Story = {
  render: () => <ModalDemo />,
};
