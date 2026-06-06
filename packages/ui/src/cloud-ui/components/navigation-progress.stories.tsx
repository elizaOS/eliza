import type { Meta, StoryObj } from "@storybook/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { NavigationProgress } from "./navigation-progress";

/**
 * `NavigationProgress` renders `null` and drives the nprogress bar as a side
 * effect when the route changes. These stories mount it inside a
 * `MemoryRouter` and provide visible links so you can click between routes
 * and watch the top-of-page progress bar flash.
 *
 * The bar itself is styled by nprogress's CSS — if the host app does not load
 * `nprogress/nprogress.css`, the bar's visuals will be unstyled in Storybook
 * but the start/done lifecycle still fires.
 */
const meta = {
  title: "CloudUI/Components/NavigationProgress",
  component: NavigationProgress,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    backgrounds: { default: "dark" },
  },
} satisfies Meta<typeof NavigationProgress>;

export default meta;
type Story = StoryObj<typeof meta>;

function DemoShell({ initialPath }: { initialPath: string }) {
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <NavigationProgress />
      <div className="min-h-screen bg-black p-6 text-white">
        <header className="mb-6 border-b border-white/10 pb-4">
          <h1 className="text-lg font-semibold">NavigationProgress demo</h1>
          <p className="text-sm text-white/60">
            Click a link below — the nprogress bar at the top of the page should
            briefly appear and fade out.
          </p>
        </header>
        <nav className="mb-6 flex gap-3 text-sm">
          <Link
            to="/dashboard"
            className="rounded border border-white/20 px-3 py-1.5 hover:bg-white/10"
          >
            /dashboard
          </Link>
          <Link
            to="/agents"
            className="rounded border border-white/20 px-3 py-1.5 hover:bg-white/10"
          >
            /agents
          </Link>
          <Link
            to="/billing"
            className="rounded border border-white/20 px-3 py-1.5 hover:bg-white/10"
          >
            /billing
          </Link>
          <Link
            to="/settings?tab=profile"
            className="rounded border border-white/20 px-3 py-1.5 hover:bg-white/10"
          >
            /settings?tab=profile
          </Link>
        </nav>
        <Routes>
          <Route
            path="*"
            element={
              <section className="rounded-lg border border-white/10 bg-white/5 p-6">
                <h2 className="mb-2 text-base font-medium">Route content</h2>
                <p className="text-sm text-white/60">
                  Real routes would render their own UI here. This stub just
                  exists so the router has something to mount on each path.
                </p>
              </section>
            }
          />
        </Routes>
      </div>
    </MemoryRouter>
  );
}

export const Default: Story = {
  render: () => <DemoShell initialPath="/dashboard" />,
};

export const StartingOnAgents: Story = {
  render: () => <DemoShell initialPath="/agents" />,
};

export const WithSearchParams: Story = {
  render: () => <DemoShell initialPath="/settings?tab=profile" />,
};
