import type { Meta, StoryObj } from "@storybook/react";
import { withMockApp } from "../../storybook/mock-providers.helpers";
import { DocumentsView } from "./DocumentsView";

/**
 * `DocumentsView` is the knowledge/documents page: an upload zone plus a
 * searchable, scope-filterable list of documents alongside a detail viewer.
 *
 * In Storybook there is no backend, so `client.listDocuments` rejects/hangs
 * on mount — these stories render the loading skeleton and then settle into
 * the empty state, which is the realistic first-paint experience.
 */
const meta = {
  title: "Pages/DocumentsView",
  component: DocumentsView,
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
} satisfies Meta<typeof DocumentsView>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default page layout: upload zone, document list rail with search + scope
 * filters, and the detail viewer. Renders the empty/loading state without a
 * backend.
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
 * Embedded variant uses the compact selector rail, suitable for narrower
 * surfaces that host the documents view inline.
 */
export const Embedded: Story = {
  args: {
    embedded: true,
  },
};

/**
 * With the selector rail hidden, the view collapses to a compact horizontal
 * strip of document chips above the detail viewer. An external file input id
 * surfaces the "Add Knowledge" trigger.
 */
export const CompactStrip: Story = {
  args: {
    showSelectorRail: false,
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
