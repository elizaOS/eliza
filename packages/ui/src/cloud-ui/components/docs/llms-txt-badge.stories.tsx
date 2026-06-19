import type { Meta, StoryObj } from "@storybook/react";
import { MemoryRouter } from "react-router-dom";
import { LlmsTxtBadge } from "./llms-txt-badge";

const meta = {
  title: "CloudUI/Docs/LlmsTxtBadge",
  component: LlmsTxtBadge,
  tags: ["autodocs"],
  parameters: {
    backgrounds: {
      default: "dark",
      values: [{ name: "dark", value: "#0a0a0a" }],
    },
  },
  decorators: [
    (Story, ctx) => {
      const initialPath =
        (ctx.parameters as { initialPath?: string }).initialPath ?? "/docs";
      return (
        <MemoryRouter initialEntries={[initialPath]}>
          <div style={{ padding: 24, background: "#0a0a0a" }}>
            <Story />
          </div>
        </MemoryRouter>
      );
    },
  ],
} satisfies Meta<typeof LlmsTxtBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * On the docs landing page (`/docs`), only the single `llms.txt` link is
 * rendered — no full-pack variant.
 */
export const DocsLanding: Story = {
  parameters: { initialPath: "/docs" },
};

/**
 * Trailing slash variant of the docs landing — same single-link behavior.
 */
export const DocsLandingTrailingSlash: Story = {
  parameters: { initialPath: "/docs/" },
};

/**
 * On any nested docs route, both the `llms.txt` index link and the
 * `llms-full` pack link render side-by-side.
 */
export const NestedDocsPage: Story = {
  parameters: { initialPath: "/docs/getting-started" },
};

/**
 * On a deeply nested docs route — same dual-link layout.
 */
export const DeepDocsPage: Story = {
  parameters: { initialPath: "/docs/guides/agents/custom-actions" },
};

/**
 * Outside the `/docs` tree the badge renders nothing. Storybook shows an
 * empty surface here to confirm the early-return path.
 */
export const HiddenOutsideDocs: Story = {
  parameters: { initialPath: "/dashboard" },
};
