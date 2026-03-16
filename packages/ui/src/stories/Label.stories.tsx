import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

const meta: Meta<typeof Label> = { title: "Atoms/Label", component: Label };
export default meta;

export const WithInput: StoryObj = {
  render: () => (
    <div className="flex flex-col gap-2">
      <Label htmlFor="email">Email</Label>
      <Input id="email" placeholder="you@milady.gg" />
    </div>
  ),
};
