/**
 * Storybook layouts for the Knowledge hub across full-page, modal, standalone,
 * external-file-input, and controlled-selection surfaces.
 */

import { withMockApp } from "@elizaos/ui/storybook/mock-providers.helpers";
import type { Meta, StoryObj } from "@storybook/react";
import { KnowledgeDocumentsView } from "./KnowledgeDocumentsView";

/**
 * `KnowledgeDocumentsView` is the Knowledge multimedia hub: a media-format facet control
 * over a single-column list, with the reader opening as a pushed sub-view.
 *
 * In Storybook there is no backend, so the mount load rejects — these stories
 * render the loading skeleton and settle into the empty state, the realistic
 * first-paint experience.
 */
const meta = {
  title: "Pages/KnowledgeDocumentsView",
  component: KnowledgeDocumentsView,
  tags: ["autodocs"],
  decorators: [
    withMockApp,
    (Story) => (
      <div className="flex h-[42rem] flex-col bg-bg p-4">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof KnowledgeDocumentsView>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default page layout: the facet control over the single-column list. Renders
 * the empty/loading state without a backend.
 */
export const Default: Story = {};

/**
 * Modal-hosted variant — used when the documents view is shown inside a dialog
 * shell (tighter min-height handling).
 */
export const InModal: Story = {
  args: {
    inModal: true,
  },
};

/**
 * Standalone variant renders its own ViewHeader; the default (non-standalone)
 * mode is headerless, embedded under another view's chrome.
 */
export const Standalone: Story = {
  args: {
    standalone: true,
  },
};

/**
 * An external file input id wires the hub's quiet "Add" intake to a host-owned
 * `<input type="file">`, the only upload affordance once the side rail is gone.
 */
export const ExternalFileInput: Story = {
  args: {
    fileInputId: "documents-file-input",
  },
};

/**
 * Controlled selection: the parent owns `selectedDocumentId` and is notified of
 * changes. With no documents loaded the viewer shows its empty state.
 */
export const ControlledSelection: Story = {
  args: {
    selectedDocumentId: null,
    onSelectedDocumentIdChange: () => {},
    onDocumentsChange: () => {},
  },
};
