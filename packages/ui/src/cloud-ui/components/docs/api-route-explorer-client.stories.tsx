/**
 * Storybook stories for the API route explorer.
 */
import type { Meta, StoryObj } from "@storybook/react";
import type { DiscoveredApiRouteDto } from "../../types/cloud-api";
import { ApiRouteExplorerClient } from "./api-route-explorer-client";

const routes: DiscoveredApiRouteDto[] = [
  {
    path: "/api/v1/agents",
    methods: ["GET", "POST"],
    filePath: "src/routes/agents/index.ts",
    meta: {
      name: "List & Create Agents",
      description:
        "Retrieve all agents in your workspace, or provision a new agent with a character definition.",
      category: "agents",
      requiresAuth: true,
      rateLimit: { requests: 120, window: "min" },
      pricing: "Credits",
      tags: ["agents", "core"],
    },
  },
  {
    path: "/api/v1/agents/{id}",
    methods: ["GET", "PATCH", "DELETE"],
    filePath: "src/routes/agents/[id].ts",
    meta: {
      name: "Agent Detail",
      description: "Read, update, or delete a single agent by id.",
      category: "agents",
      requiresAuth: true,
      rateLimit: "60/min",
      tags: ["agents"],
    },
  },
  {
    path: "/api/v1/chat/completions",
    methods: ["POST"],
    filePath: "src/routes/chat/completions.ts",
    meta: {
      name: "Chat Completions",
      description:
        "Stream a chat completion from a model. OpenAI-compatible request body.",
      category: "chat",
      requiresAuth: true,
      pricing: { type: "metered" },
      tags: ["chat", "inference"],
    },
  },
  {
    path: "/api/v1/discovery/routes",
    methods: ["GET"],
    filePath: "src/routes/discovery/routes.ts",
    meta: {
      name: "Route Discovery",
      description: "Public list of documented API routes.",
      category: "discovery",
      requiresAuth: false,
      tags: ["public"],
    },
  },
  {
    path: "/api/v1/credits/balance",
    methods: ["GET"],
    filePath: "src/routes/credits/balance.ts",
  },
  {
    path: "/api/v1/admin/users",
    methods: ["GET"],
    filePath: "src/routes/admin/users.ts",
    meta: {
      name: "Admin: Users",
      description: "Administrative user listing (hidden unless Show all).",
      category: "admin",
      requiresAuth: true,
      tags: ["admin"],
    },
  },
];

const meta = {
  title: "Docs/ApiRouteExplorerClient",
  component: ApiRouteExplorerClient,
  tags: ["autodocs"],
  parameters: { backgrounds: { default: "dark" } },
  decorators: [
    (Story) => (
      <div className="dark bg-black p-6 text-white">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ApiRouteExplorerClient>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { routes },
};

export const Empty: Story = {
  args: { routes: [] },
};

export const SingleRoute: Story = {
  args: { routes: [routes[2]] },
};
