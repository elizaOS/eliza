/** Shows a component example under each supported product theme. */
import type { ReactNode } from "react";

interface ComparisonExample {
  id: string;
  name: string;
  importPath: string;
  description?: string;
  render: () => ReactNode;
}
export function ThemeComparison({ story }: { story: ComparisonExample }) {
  return (
    <article className="space-y-4 p-6" id={story.id}>
      <h2 className="text-xl font-semibold">{story.name}</h2>
      <code className="text-sm">{story.importPath}</code>
      {story.description ? <p>{story.description}</p> : null}
      <div className="grid gap-4 lg:grid-cols-3">
        {["theme-cloud", "theme-os", "theme-app"].map((theme) => (
          <section key={theme} className={theme}>
            <div className="min-h-32 space-y-4 rounded border border-border bg-bg p-4 text-txt">
              <h3 className="text-xs text-muted">{theme}</h3>
              {story.render()}
            </div>
          </section>
        ))}
      </div>
    </article>
  );
}
