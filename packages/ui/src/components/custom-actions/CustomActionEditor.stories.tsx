/** Storybook stories for CustomActionEditor across handler types and create/edit modes, under a stub AppContext supplying `t`. */

import type { CustomActionDef } from "@elizaos/shared";
import type { Meta, StoryObj } from "@storybook/react";
import type { AppContextValue } from "../../state/types";
import { AppContext } from "../../state/useApp";
import { CustomActionEditor } from "./CustomActionEditor";

const mockAppContext = new Proxy({} as AppContextValue, {
  get(_, prop) {
    if (prop === "t") {
      return (_key: string, opts?: { defaultValue?: string }) =>
        opts?.defaultValue ?? "";
    }
    if (prop === "uiLanguage") return "en";
    if (prop === "navigation") {
      return {
        scheduleAfterTabCommit: (fn: () => void) => {
          queueMicrotask(fn);
        },
      };
    }
    return () => {};
  },
});

const sampleHttpAction: CustomActionDef = {
  id: "act-http-1",
  name: "CHECK_WEBSITE_STATUS",
  description: "Pings a website and returns the HTTP status code.",
  similes: ["PING_SITE", "WEBSITE_STATUS"],
  parameters: [
    { name: "url", description: "Website URL to check", required: true },
    {
      name: "timeout",
      description: "Timeout in milliseconds",
      required: false,
    },
  ],
  handler: {
    type: "http",
    method: "GET",
    url: "https://api.example.com/status?url={{url}}",
    headers: { Accept: "application/json" },
    bodyTemplate: "",
  },
  enabled: true,
};

const sampleShellAction: CustomActionDef = {
  id: "act-shell-1",
  name: "DISK_USAGE_REPORT",
  description: "Returns a human-readable disk usage report.",
  similes: ["DF", "STORAGE_REPORT"],
  parameters: [],
  handler: {
    type: "shell",
    command: "df -h",
  },
  enabled: true,
};

const sampleCodeAction: CustomActionDef = {
  id: "act-code-1",
  name: "SUM_NUMBERS",
  description: "Adds two numbers passed as parameters.",
  similes: ["ADD", "PLUS"],
  parameters: [
    { name: "a", description: "First number", required: true },
    { name: "b", description: "Second number", required: true },
  ],
  handler: {
    type: "code",
    code: "return Number(params.a) + Number(params.b);",
  },
  enabled: true,
};

const meta = {
  title: "CustomActions/CustomActionEditor",
  component: CustomActionEditor,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <AppContext.Provider value={mockAppContext}>
        <div className="p-6">
          <Story />
        </div>
      </AppContext.Provider>
    ),
  ],
  argTypes: {
    open: { control: "boolean" },
    action: { control: false },
    onSave: { action: "saved" },
    onClose: { action: "closed" },
  },
  args: {
    open: true,
    action: null,
    onSave: () => {},
    onClose: () => {},
  },
} satisfies Meta<typeof CustomActionEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NewAction: Story = {
  args: {
    action: null,
  },
};

export const EditHttpAction: Story = {
  args: {
    action: sampleHttpAction,
  },
};

export const EditShellAction: Story = {
  args: {
    action: sampleShellAction,
  },
};

export const EditCodeAction: Story = {
  args: {
    action: sampleCodeAction,
  },
};

export const Closed: Story = {
  args: {
    open: false,
  },
};
