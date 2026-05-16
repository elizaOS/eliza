import type { ReactNode } from "react";

export interface StoryDefinition {
  /** Anchor id (slug). Must be unique across the whole gallery. */
  id: string;
  /** Display name shown in the section header and the TOC. */
  name: string;
  /** Copy-pasteable import line shown under the name. */
  importPath: string;
  /** Optional short description rendered above the triptych. */
  description?: string;
  /** Renders the component sample. Called once per theme tile. */
  render: () => ReactNode;
}

export interface StoryGroup {
  id: string;
  title: string;
  stories: StoryDefinition[];
}

const SURFACES = [
  { className: "theme-cloud", label: "theme-cloud — Eliza Cloud" },
  { className: "theme-os", label: "theme-os — elizaOS" },
  { className: "theme-app", label: "theme-app — Eliza App" },
] as const;

export function Story({ story }: { story: StoryDefinition }) {
  return (
    <article className="gallery-section" id={story.id}>
      <div className="gallery-eyebrow">component</div>
      <div className="gallery-name">{story.name}</div>
      <code className="gallery-import">{story.importPath}</code>
      {story.description ? (
        <p className="gallery-description">{story.description}</p>
      ) : null}
      <div className="gallery-triptych">
        {SURFACES.map((surface) => (
          <div
            key={surface.className}
            className={`gallery-tile ${surface.className}`}
          >
            <div className="gallery-tile-label">{surface.label}</div>
            <div className="gallery-tile-body">{story.render()}</div>
          </div>
        ))}
      </div>
    </article>
  );
}
