import type { Meta, StoryObj } from "@storybook/react";
import { withMockApp } from "../../storybook/mock-providers.helpers";
import { DesktopWorkspaceSection } from "./DesktopWorkspaceSection";

/**
 * `DesktopWorkspaceSection` surfaces Electrobun desktop tooling — diagnostics,
 * window controls, file dialogs, clipboard, and lifecycle actions.
 *
 * In Storybook the Electrobun runtime is not present, so the component renders
 * its graceful "desktop tools only available" fallback card. This is the
 * expected non-desktop state and the realistic web-shell rendering.
 */
const meta = {
  title: "Settings/DesktopWorkspaceSection",
  component: DesktopWorkspaceSection,
  tags: ["autodocs"],
  decorators: [withMockApp],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof DesktopWorkspaceSection>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default rendering outside the desktop runtime: a single card explaining that
 * the desktop workspace tools are unavailable in the current environment.
 */
export const Default: Story = {};

/**
 * Same fallback state, but with a custom content header passed through to the
 * surrounding `ContentLayout`.
 */
export const WithContentHeader: Story = {
  args: {
    contentHeader: (
      <div className="border-border border-b px-4 py-3">
        <h2 className="font-semibold text-txt">Desktop Workspace</h2>
        <p className="text-muted text-sm">
          Diagnostics, window controls, and native bridges for the desktop app.
        </p>
      </div>
    ),
  },
};
