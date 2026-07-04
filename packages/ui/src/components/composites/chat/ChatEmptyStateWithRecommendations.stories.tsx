/**
 * Storybook states for the ChatEmptyStateWithRecommendations chat composite
 * used by shared conversation and composer surfaces.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { FileText, KeyRound } from "lucide-react";
import { ChatEmptyStateWithRecommendations } from "./ChatEmptyStateWithRecommendations";

const meta = {
  title: "Composites/Chat/ChatEmptyStateWithRecommendations",
  component: ChatEmptyStateWithRecommendations,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ChatEmptyStateWithRecommendations>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Recommendations: Story = {
  args: {
    icon: FileText,
    recommendations: [
      "Upload a document",
      "Summarize my notes",
      "Search my knowledge",
    ],
  },
};

export const SetupCta: Story = {
  args: {
    title: "Add a wallet key to see balances",
    primaryAction: { label: "Add keys", onClick: () => {}, icon: KeyRound },
  },
};

export const SetupWithRecommendations: Story = {
  args: {
    title: "No relationships yet",
    primaryAction: { label: "Add a contact", onClick: () => {} },
    recommendations: ["Who do I know?", "Add my team", "Import from Discord"],
  },
};
