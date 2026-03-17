import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

const meta: Meta<typeof Select> = {
  title: "Molecules/Select",
  component: Select,
};
export default meta;

export const Default: StoryObj = {
  render: () => (
    <Select>
      <SelectTrigger className="w-56">
        <SelectValue placeholder="Model" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value="gpt4">GPT-4o</SelectItem>
          <SelectItem value="claude">Claude 3.5</SelectItem>
          <SelectItem value="llama">Llama 3.1</SelectItem>
          <SelectItem value="gemini">Gemini Pro</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  ),
};
