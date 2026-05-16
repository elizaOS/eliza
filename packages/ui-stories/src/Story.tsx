import type { ReactNode } from "react";

export interface StoryDefinition {
  name: string;
  importPath: string;
  description?: string;
  render: () => ReactNode;
}

export interface StoryGroup {
  id: string;
  title: string;
  stories: StoryDefinition[];
}

export function Story({ story }: { story: StoryDefinition }) {
  return (
    <article className="gallery-section">
      <div className="gallery-eyebrow">component</div>
      <div className="gallery-name">{story.name}</div>
      <code className="gallery-import">{story.importPath}</code>
      {story.description ? (
        <p style={{ opacity: 0.7, fontSize: 13, marginBottom: 12 }}>
          {story.description}
        </p>
      ) : null}
      <div className="gallery-row">{story.render()}</div>
    </article>
  );
}
