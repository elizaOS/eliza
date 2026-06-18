import type { Meta, StoryObj } from "@storybook/react";
import { MemoryRouter } from "react-router-dom";
import { DocsLayout } from "./docs-layout";
import type { NavItem } from "./docs-types";

const navItems: NavItem[] = [
  { kind: "separator", id: "intro", title: "Introduction" },
  { kind: "page", slug: "overview", title: "Overview", path: "/docs" },
  {
    kind: "page",
    slug: "getting-started",
    title: "Getting Started",
    path: "/docs/getting-started",
  },
  { kind: "separator", id: "guides", title: "Guides" },
  {
    kind: "section",
    slug: "agents",
    title: "Agents",
    path: "/docs/agents",
    children: [
      {
        kind: "page",
        slug: "actions",
        title: "Custom Actions",
        path: "/docs/agents/actions",
      },
      {
        kind: "page",
        slug: "providers",
        title: "Providers",
        path: "/docs/agents/providers",
      },
    ],
  },
  {
    kind: "section",
    slug: "deployment",
    title: "Deployment",
    path: "/docs/deployment",
    children: [
      {
        kind: "page",
        slug: "cloud",
        title: "Eliza Cloud",
        path: "/docs/deployment/cloud",
      },
    ],
  },
];

const SampleContent = () => (
  <article style={{ maxWidth: 640 }}>
    <h1>Getting Started</h1>
    <p>
      Welcome to the Eliza Cloud documentation. This layout pairs a persistent
      navigation sidebar with the main content region.
    </p>
    <p>
      The active route is highlighted in the sidebar based on the current
      pathname.
    </p>
  </article>
);

const meta = {
  title: "CloudUI/Docs/DocsLayout",
  component: DocsLayout,
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
          <Story />
        </MemoryRouter>
      );
    },
  ],
} satisfies Meta<typeof DocsLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default docs shell on the landing route — the "Overview" page link is active.
 */
export const Default: Story = {
  args: {
    navItems,
    children: <SampleContent />,
  },
};

/**
 * A nested page route highlights the matching leaf link inside its section.
 */
export const NestedPageActive: Story = {
  args: {
    navItems,
    children: <SampleContent />,
  },
  parameters: { initialPath: "/docs/agents/actions" },
};

/**
 * Section-title routes mark the whole section as active (prefix match).
 */
export const SectionActive: Story = {
  args: {
    navItems,
    children: <SampleContent />,
  },
  parameters: { initialPath: "/docs/deployment" },
};

/**
 * Custom branding label and target via the optional props.
 */
export const CustomBrand: Story = {
  args: {
    navItems,
    brandLabel: "Acme Docs",
    brandTo: "/docs/getting-started",
    children: <SampleContent />,
  },
};

/**
 * An empty navigation list still renders the shell and brand link.
 */
export const EmptyNav: Story = {
  args: {
    navItems: [],
    children: <SampleContent />,
  },
};
