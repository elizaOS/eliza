import type { Meta, StoryObj } from "@storybook/react";
import React, { useState } from "react";
import { SearchInput } from "../components/ui/search-input";

const meta: Meta<typeof SearchInput> = {
  title: "Molecules/SearchInput",
  component: SearchInput,
};
export default meta;

export const Default: StoryObj = {
  render: () => {
    const [v, setV] = useState("agent-alpha");
    return (
      <SearchInput
        value={v}
        onChange={(e) => setV(e.target.value)}
        onClear={() => setV("")}
        placeholder="Search agents…"
        className="w-64"
      />
    );
  },
};
