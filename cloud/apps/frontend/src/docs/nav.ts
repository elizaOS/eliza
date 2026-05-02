// Reads `cloud/packages/content/**/_meta.ts` at build time and turns it
// into a sidebar tree, plus a map of /docs/<slug> → lazy MDX loader. The
// MDX sources live in `packages/content/`. Types for the nav tree live in
// `@elizaos/cloud-ui`; this file is app-local because `import.meta.glob`
// paths are resolved from the Vite app root.

import type { MdxModule, NavItem } from "@elizaos/cloud-ui";

export type { DocsFrontmatter, MdxModule, NavItem } from "@elizaos/cloud-ui";

type MetaValue =
  | string
  | {
      title?: string;
      type?: "separator" | "page";
      theme?: { layout?: string; toc?: boolean };
    };

type MetaModule = { default: Record<string, MetaValue> };

const metaModules = import.meta.glob<MetaModule>(
  "../../../../packages/content/**/_meta.ts",
  { eager: true },
);

const mdxModules = import.meta.glob<MdxModule>(
  "../../../../packages/content/**/*.mdx",
);

function toDocsPath(globKey: string): string {
  const rel = globKey
    .replace("../../../../packages/content/", "")
    .replace(/\.mdx$/, "");
  if (rel === "index") return "/docs";
  if (rel.endsWith("/index")) return `/docs/${rel.slice(0, -"/index".length)}`;
  return `/docs/${rel}`;
}

export const mdxLoaders = new Map<string, () => Promise<MdxModule>>();
for (const [globKey, loader] of Object.entries(mdxModules)) {
  mdxLoaders.set(toDocsPath(globKey), loader);
}

function metaFor(dir: string): Record<string, MetaValue> | null {
  const key = dir
    ? `../../../../packages/content/${dir}/_meta.ts`
    : "../../../../packages/content/_meta.ts";
  return metaModules[key]?.default ?? null;
}

function hasMetaForSubdir(dir: string, key: string): boolean {
  const sub = dir ? `${dir}/${key}` : key;
  return Boolean(metaModules[`../../../../packages/content/${sub}/_meta.ts`]);
}

function buildTree(dir: string, basePath: string): NavItem[] {
  const meta = metaFor(dir);
  if (!meta) return [];
  const items: NavItem[] = [];
  for (const [key, value] of Object.entries(meta)) {
    if (key === "*") continue;
    if (
      typeof value === "object" &&
      value !== null &&
      value.type === "separator"
    ) {
      items.push({
        kind: "separator",
        id: key,
        title: typeof value.title === "string" ? value.title : "",
      });
      continue;
    }
    const title =
      typeof value === "string"
        ? value
        : (typeof value === "object" && value?.title) || key;
    if (hasMetaForSubdir(dir, key)) {
      const childPath = `${basePath}/${key}`;
      const childDir = dir ? `${dir}/${key}` : key;
      items.push({
        kind: "section",
        slug: key,
        title,
        path: childPath,
        children: buildTree(childDir, childPath),
      });
    } else {
      const path = key === "index" ? basePath : `${basePath}/${key}`;
      items.push({ kind: "page", slug: key, title, path });
    }
  }
  return items;
}

export const docsNav: NavItem[] = buildTree("", "/docs");
