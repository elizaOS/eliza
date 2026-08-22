/**
 * Root component of the standalone story gallery app: composes every story group into one page.
 */

import { useEffect, useState } from "react";
import { Story, type StoryGroup } from "./Story.tsx";
import { analyticsStories } from "./stories/analytics.tsx";
import { brandStories } from "./stories/brand.tsx";
import { cloudDashboardStories } from "./stories/cloud-dashboard.tsx";
import { featureSurfaceStories } from "./stories/feature-surfaces.tsx";
import { primitiveStories } from "./stories/primitives.tsx";
import { shellFoundationStories } from "./stories/shell-foundation.tsx";

const groups: StoryGroup[] = [
  {
    id: "primitives",
    title: "Primitives — @elizaos/ui/components/ui",
    stories: primitiveStories,
  },
  {
    id: "brand",
    title: "Brand — @elizaos/ui/cloud-ui/components/brand",
    stories: brandStories,
  },
  {
    id: "cloud-dashboard",
    title: "Cloud Dashboard — shared composites",
    stories: cloudDashboardStories,
  },
  {
    id: "analytics",
    title: "Analytics — shared dashboard views",
    stories: analyticsStories,
  },
  {
    id: "shell-foundation",
    title: "Shell Foundation — @elizaos/ui/components/shell",
    stories: shellFoundationStories,
  },
  {
    id: "feature-surfaces",
    title: "Feature Surfaces — apps, local inference, policy controls",
    stories: featureSurfaceStories,
  },
];

export function App() {
  const [focusedId, setFocusedId] = useState(() =>
    window.location.hash.replace(/^#/, ""),
  );
  useEffect(() => {
    const onHashChange = () =>
      setFocusedId(window.location.hash.replace(/^#/, ""));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const focusedStory = groups
    .flatMap((group) => group.stories)
    .find((story) => story.id === focusedId);
  if (focusedStory) {
    return (
      <div className="gallery-shell gallery-shell--focused">
        <main className="gallery-main">
          <header className="gallery-focus-header">
            <a href={window.location.pathname}>All components</a>
            <span>Eliza App preview</span>
          </header>
          <section className="gallery-group gallery-group--focused">
            <Story story={focusedStory} focused />
          </section>
        </main>
      </div>
    );
  }
  return (
    <div className="gallery-shell">
      <nav className="gallery-toc" aria-label="Component catalog">
        <div className="gallery-toc-title">elizaOS UI Catalog</div>
        <div className="gallery-toc-subtitle">cloud · os · app</div>
        {groups.map((g) => (
          <div key={g.id}>
            <div className="gallery-toc-group">{g.id}</div>
            {g.stories.map((s) => (
              <a key={s.id} href={`#${s.id}`}>
                {s.name}
              </a>
            ))}
          </div>
        ))}
      </nav>

      <main className="gallery-main">
        <header className="gallery-hero">
          <h1>elizaOS UI Catalog</h1>
          <p>
            Brand reference: clouds + Poppins + xs rounding + flat color. xs
            radius = 4 px max. No glass. Every primitive is rendered three
            times, once under each theme class so you can spot drift at a
            glance.
          </p>
          <div className="gallery-hero-chips">
            <span className="gallery-chip">
              <span
                className="gallery-chip-dot"
                style={{ background: "#17adff" }}
              />
              theme-cloud
            </span>
            <span className="gallery-chip">
              <span
                className="gallery-chip-dot"
                style={{ background: "#0b35f1" }}
              />
              theme-os
            </span>
            <span className="gallery-chip">
              <span
                className="gallery-chip-dot"
                style={{ background: "#ff5800" }}
              />
              theme-app
            </span>
          </div>
        </header>

        {groups.map((group) => (
          <section key={group.id} className="gallery-group" id={group.id}>
            <h2 className="gallery-group-title">{group.title}</h2>
            {group.stories.map((s) => (
              <Story key={s.id} story={s} />
            ))}
          </section>
        ))}
      </main>
    </div>
  );
}
