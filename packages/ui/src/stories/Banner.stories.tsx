import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import { Banner } from "../components/ui/banner";

const meta: Meta<typeof Banner> = {
  title: "Molecules/Banner",
  component: Banner,
};
export default meta;

export const AllVariants: StoryObj = {
  render: () => (
    <div className="space-y-3 max-w-xl">
      <Banner variant="info">New version available.</Banner>
      <Banner variant="warning">API key expires in 3 days.</Banner>
      <Banner variant="error">Agent offline — last seen 12m ago.</Banner>
    </div>
  ),
};
