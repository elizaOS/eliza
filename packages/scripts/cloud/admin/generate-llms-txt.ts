import fs from "node:fs/promises";
import path from "node:path";

type DocEntry = {
  title: string;
  description?: string;
  urlPath: string; // e.g. /docs/quickstart
  sourcePath: string;
  content?: string;
};

function stripExt(p: string) {
  return p.replace(/\.(md|mdx)$/i, "");
}

function normalizeSlashes(p: string) {
  return p.replace(/\\/g, "/");
}

function parseFrontmatter(source: string): {
  title?: string;
  description?: string;
} {
  // Very small YAML-ish parser for our simple frontmatter:
  // ---
  // title: Foo
  // description: Bar
  // ---
  if (!source.startsWith("---")) return {};
  const end = source.indexOf("\n---", 3);
  if (end === -1) return {};
  const raw = source.slice(3, end).trim();

  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    val = val.replace(/^["']|["']$/g, "");
    out[key] = val;
  }

  return {
    title: out.title,
    description: out.description,
  };
}

function stripFrontmatter(source: string): string {
  if (!source.startsWith("---")) return source;
  const end = source.indexOf("\n---", 3);
  if (end === -1) return source;
  return source.slice(end + "\n---".length).replace(/^\s*\n/, "");
}

function mdxToMarkdown(source: string): string {
  let s = source;

  // Remove import/export lines (MDX pages often start with component imports)
  s = s.replace(/^\s*import\s+.*$/gm, "");
  s = s.replace(/^\s*export\s+.*$/gm, "");

  // Convert simple inline HTML code tags to markdown backticks
  s = s.replace(/<code>([\s\S]*?)<\/code>/g, (_m, inner) => `\`${String(inner).trim()}\``);

  // Drop JSX component tags (Callout, Tabs, Steps, Cards, etc.)
  // We remove the tags but keep the inner markdown.
  s = s.replace(/<([A-Z][A-Za-z0-9]*)\b[^>]*\/>/g, ""); // self-closing
  s = s.replace(/<\/?([A-Z][A-Za-z0-9]*)\b[^>]*>/g, ""); // open/close

  // Collapse excessive whitespace
  s = s.replace(/\n{3,}/g, "\n\n").trim();

  return s;
}

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];

  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await walk(full)));
      continue;
    }
    if (!ent.isFile()) continue;
    if (!/\.(md|mdx)$/i.test(ent.name)) continue;
    out.push(full);
  }

  return out;
}

function toDocsUrlPath(contentDir: string, filePath: string): string {
  const rel = normalizeSlashes(path.relative(contentDir, filePath));
  const noExt = stripExt(rel);

  // Nextra routing:
  // - content/index.mdx -> /docs
  // - content/foo.mdx -> /docs/foo
  // - content/api/index.mdx -> /docs/api
  // - content/api/overview.mdx -> /docs/api/overview
  const parts = noExt.split("/").filter(Boolean);
  if (parts.length === 1 && parts[0] === "index") return "/docs";
  if (parts.length > 1 && parts[parts.length - 1] === "index") {
    parts.pop();
  }
  return `/docs/${parts.join("/")}`;
}

function normalizeBaseUrl(raw?: string): string {
  const base = (raw || "").trim();
  if (!base) return "https://elizacloud.ai";
  if (base.startsWith("http://") || base.startsWith("https://")) return base.replace(/\/+$/, "");
  // If someone passes a bare host, treat as https
  return `https://${base}`.replace(/\/+$/, "");
}

function formatLlmsTxt(baseUrl: string, pages: DocEntry[]): string {
  const lines: string[] = [];
  lines.push("# Eliza Cloud Documentation");
  lines.push("");
  lines.push(
    "This is an LLM-friendly index of the Eliza Cloud docs (for tools like Cursor, ChatGPT, etc.).",
  );
  lines.push("");
  lines.push(`Base URL: ${baseUrl}`);
  lines.push(`Docs root: ${baseUrl}/docs`);
  lines.push(`llms.txt: ${baseUrl}/.well-known/llms.txt`);
  lines.push(`llms-full.txt: ${baseUrl}/.well-known/llms-full.txt`);
  lines.push("");
  lines.push("## Pages");
  lines.push("");

  for (const p of pages) {
    const abs = `${baseUrl}${p.urlPath}`;
    const desc = p.description ? ` — ${p.description}` : "";
    lines.push(`- ${p.title}${desc}`);
    lines.push(`  ${abs}`);
  }

  lines.push("");
  return lines.join("\n");
}

function formatLlmsFullTxt(baseUrl: string, pages: DocEntry[]): string {
  const lines: string[] = [];
  lines.push("# elizaOS Cloud Documentation (Full)");
  lines.push("");
  lines.push(
    "This file contains the concatenated contents of the elizaOS Cloud docs for LLM ingestion (Cursor, ChatGPT, etc.).",
  );
  lines.push("");
  lines.push(`Base URL: ${baseUrl}`);
  lines.push(`Docs root: ${baseUrl}/docs`);
  lines.push(`Index: ${baseUrl}/.well-known/llms.txt`);
  lines.push("");

  for (const p of pages) {
    const abs = `${baseUrl}${p.urlPath}`;
    lines.push("---");
    lines.push("");
    lines.push(`## ${p.title}`);
    lines.push("");
    lines.push(`URL: ${abs}`);
    if (p.description) {
      lines.push("");
      lines.push(`Summary: ${p.description}`);
    }
    lines.push("");
    lines.push((p.content || "").trim());
    lines.push("");
  }

  lines.push("");
  return lines.join("\n");
}

async function main() {
  const root = process.cwd();
  const contentDir = path.join(root, "packages/content");
  const publicDir = path.join(root, "public");
  const wellKnownDir = path.join(publicDir, ".well-known");
  const vitePublicDir = path.join(root, "apps/frontend/public");
  const viteWellKnownDir = path.join(vitePublicDir, ".well-known");

  const baseUrl = normalizeBaseUrl(
    process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL,
  );

  const files = await walk(contentDir);

  const pages: DocEntry[] = [];
  for (const f of files) {
    const raw = await fs.readFile(f, "utf8");
    const fm = parseFrontmatter(raw);
    const body = stripFrontmatter(raw);
    const urlPath = toDocsUrlPath(contentDir, f);

    // Default title if frontmatter missing (should be rare)
    const title = fm.title || path.basename(stripExt(f));
    const description = fm.description;

    const content = mdxToMarkdown(body);
    pages.push({ title, description, urlPath, sourcePath: f, content });
  }

  pages.sort((a, b) => a.urlPath.localeCompare(b.urlPath));

  const llms = formatLlmsTxt(baseUrl, pages);
  const llmsFull = formatLlmsFullTxt(baseUrl, pages);

  await fs.mkdir(wellKnownDir, { recursive: true });
  await fs.mkdir(viteWellKnownDir, { recursive: true });

  const writes: Array<Promise<void>> = [
    fs.writeFile(path.join(publicDir, "llms.txt"), llms, "utf8"),
    fs.writeFile(path.join(wellKnownDir, "llms.txt"), llms, "utf8"),
    fs.writeFile(path.join(publicDir, "llms-full.txt"), llmsFull, "utf8"),
    fs.writeFile(path.join(wellKnownDir, "llms-full.txt"), llmsFull, "utf8"),
    fs.writeFile(path.join(vitePublicDir, "llms.txt"), llms, "utf8"),
    fs.writeFile(path.join(viteWellKnownDir, "llms.txt"), llms, "utf8"),
    fs.writeFile(path.join(vitePublicDir, "llms-full.txt"), llmsFull, "utf8"),
    fs.writeFile(path.join(viteWellKnownDir, "llms-full.txt"), llmsFull, "utf8"),
  ];
  await Promise.all(writes);

  console.log(
    `Generated llms.txt + llms-full.txt with ${pages.length} pages -> public/, apps/frontend/public/ (each with .well-known/)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
