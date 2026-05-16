import { Story, StoryGroup } from "./Story.tsx";
import { primitiveStories } from "./stories/primitives.tsx";
import { brandStories } from "./stories/brand.tsx";

const surfaces = [
  { className: "theme-cloud", label: "theme-cloud — Eliza Cloud" },
  { className: "theme-os", label: "theme-os — elizaOS" },
  { className: "theme-app", label: "theme-app — Eliza App" },
] as const;

export function App() {
  const groups: StoryGroup[] = [
    { id: "primitives", title: "Primitives — @elizaos/ui/components/ui", stories: primitiveStories },
    { id: "brand", title: "Brand — @elizaos/ui/cloud-ui/components/brand", stories: brandStories },
  ];

  return (
    <div className="gallery-shell">
      <nav className="gallery-toc">
        <strong style={{ color: "#fff" }}>elizaOS UI Catalog</strong>
        {groups.map((g) => (
          <a key={g.id} href={`#${g.id}`}>
            #{g.id}
          </a>
        ))}
      </nav>

      {surfaces.map((surface) => (
        <section
          key={surface.className}
          className={`gallery-surface ${surface.className}`}
        >
          <div className="gallery-surface-title">{surface.label}</div>

          {groups.map((group) => (
            <div key={group.id} id={group.id}>
              <h2
                style={{
                  fontSize: 24,
                  fontWeight: 700,
                  marginTop: 24,
                  marginBottom: 8,
                  letterSpacing: "-0.01em",
                }}
              >
                {group.title}
              </h2>
              {group.stories.map((s) => (
                <Story key={s.name} story={s} />
              ))}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
