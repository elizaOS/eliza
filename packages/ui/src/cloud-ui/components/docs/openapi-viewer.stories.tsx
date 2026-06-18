import type { Meta, StoryObj } from "@storybook/react";
import { OpenApiViewer } from "./openapi-viewer";

const sampleSpec = JSON.stringify(
  {
    openapi: "3.0.3",
    info: {
      title: "Eliza Agent API",
      version: "1.4.0",
      description: "HTTP surface for interacting with a running Eliza agent.",
    },
    servers: [{ url: "https://api.example.com/v1" }],
    paths: {
      "/agents/{agentId}/messages": {
        post: {
          summary: "Send a message to an agent",
          parameters: [
            {
              name: "agentId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/MessageInput" },
              },
            },
          },
          responses: {
            "200": { description: "Message accepted" },
            "404": { description: "Agent not found" },
          },
        },
      },
    },
    components: {
      schemas: {
        MessageInput: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string" },
            attachments: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
  null,
  2,
);

const meta = {
  title: "CloudUI/Docs/OpenApiViewer",
  component: OpenApiViewer,
  tags: ["autodocs"],
  args: {
    value: sampleSpec,
  },
  decorators: [
    (Story) => (
      <div className="max-w-3xl p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof OpenApiViewer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Minimal: Story = {
  args: {
    value: JSON.stringify(
      { openapi: "3.0.3", info: { title: "Tiny API", version: "0.1.0" } },
      null,
      2,
    ),
  },
};

export const Empty: Story = {
  args: {
    value: "",
  },
};

export const Constrained: Story = {
  args: {
    className: "max-w-sm",
  },
};
