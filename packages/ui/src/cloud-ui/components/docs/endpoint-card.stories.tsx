/**
 * Storybook stories for the docs EndpointCard.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { Bot, Database, Image as ImageIcon, Mic } from "lucide-react";
import type { ReactNode } from "react";

import { EndpointCard } from "./endpoint-card";

const noop = () => {};

const methodColors: Record<string, string> = {
  GET: "bg-emerald-500/20 text-emerald-300",
  POST: "bg-sky-500/20 text-sky-300",
  PUT: "bg-amber-500/20 text-amber-300",
  DELETE: "bg-red-500/20 text-red-300",
};

const categoryIcons: Record<string, ReactNode> = {
  inference: <Bot className="h-3.5 w-3.5" />,
  storage: <Database className="h-3.5 w-3.5" />,
  vision: <ImageIcon className="h-3.5 w-3.5" />,
  audio: <Mic className="h-3.5 w-3.5" />,
};

const getMethodColor = (method: string) =>
  methodColors[method] ?? "bg-neutral-500/20 text-neutral-300";

const getCategoryIcon = (category: string) =>
  categoryIcons[category] ?? <Bot className="h-3.5 w-3.5" />;

const meta = {
  title: "CloudUI/Docs/EndpointCard",
  component: EndpointCard,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="max-w-md bg-black p-6">
        <Story />
      </div>
    ),
  ],
  args: {
    onSelect: noop,
    getMethodColor,
    getCategoryIcon,
  },
} satisfies Meta<typeof EndpointCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    endpoint: {
      name: "Generate Completion",
      description:
        "Stream a text completion from the routed inference model. Supports tool calls and structured output.",
      method: "POST",
      path: "/v1/inference/completions",
      category: "inference",
      tags: ["streaming", "tools"],
      pricing: {
        cost: 0.0025,
        unit: "1K tokens",
      },
    },
  },
};

export const FreeEndpoint: Story = {
  args: {
    endpoint: {
      name: "List Models",
      description: "Return the catalog of available inference models.",
      method: "GET",
      path: "/v1/models",
      category: "inference",
      tags: ["catalog"],
      pricing: {
        isFree: true,
      },
    },
  },
};

export const VariablePricing: Story = {
  args: {
    endpoint: {
      name: "Generate Image",
      description:
        "Render an image from a prompt. Price varies by resolution and steps.",
      method: "POST",
      path: "/v1/images/generate",
      category: "vision",
      tags: ["image", "diffusion", "preview"],
      pricing: {
        isVariable: true,
        estimatedRange: { min: 0.004, max: 0.12 },
        unit: "image",
      },
    },
  },
};

export const Deprecated: Story = {
  args: {
    endpoint: {
      name: "Legacy Transcribe",
      description:
        "Transcribe audio using the v0 pipeline. Replaced by /v2/audio/transcribe.",
      method: "POST",
      path: "/v1/audio/transcribe",
      category: "audio",
      tags: ["asr", "legacy"],
      deprecated: true,
      pricing: {
        cost: 0.012,
        unit: "minute",
      },
    },
  },
};

export const ManyTags: Story = {
  args: {
    endpoint: {
      name: "Upsert Memory",
      description:
        "Insert or update a memory record in the agent's long-term store.",
      method: "PUT",
      path: "/v1/memory/upsert",
      category: "storage",
      tags: ["memory", "vector", "embeddings", "rag"],
      pricing: {
        cost: 0.0001,
        unit: "record",
      },
    },
    formatPricing: (pricing) =>
      typeof pricing.cost === "number"
        ? `$${pricing.cost.toFixed(4)}`
        : "Credits",
  },
};
