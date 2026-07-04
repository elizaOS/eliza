/**
 * Storybook stories for the Settings → Backup & Reset section, covering the
 * export/import dialogs across resting, primed, busy, error, and success states
 * with a mock App context (no backend).
 */

import type { Meta, StoryObj } from "@storybook/react";
import { mockApp, withMockApp } from "../../storybook/mock-providers.helpers";
import { AdvancedSection } from "./AdvancedSection";

const meta = {
  title: "Settings/AdvancedSection",
  component: AdvancedSection,
  tags: ["autodocs"],
  decorators: [withMockApp],
  parameters: { layout: "padded" },
} satisfies Meta<typeof AdvancedSection>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default resting state: export / import cards, developer-mode toggle, danger zone. */
export const Default: Story = {};

/** Export flow primed with a password and "include logs" enabled. */
export const ExportPrimed: Story = {
  decorators: [
    mockApp({
      exportPassword: "correct-horse-battery-staple",
      exportIncludeLogs: true,
    }),
  ],
};

/** Export currently running — submit button shows a spinner and is disabled. */
export const ExportBusy: Story = {
  decorators: [
    mockApp({
      exportBusy: true,
      exportPassword: "correct-horse-battery-staple",
    }),
  ],
};

/** Export finished with an error message surfaced in the dialog. */
export const ExportError: Story = {
  decorators: [
    mockApp({
      exportError: "Failed to encrypt backup: incorrect password.",
    }),
  ],
};

/** Import flow with a selected file, busy spinner, and a success banner. */
export const ImportInProgress: Story = {
  decorators: [
    mockApp({
      importBusy: true,
      importPassword: "correct-horse-battery-staple",
      importFile: new File(["agent"], "my-agent.eliza-agent"),
      importSuccess: "Agent imported successfully. Restarting…",
    }),
  ],
};
