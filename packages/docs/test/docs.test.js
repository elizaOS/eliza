import assert from "node:assert";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, "..");

function collectMarkdownFiles(dir = DOCS_DIR) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }

    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectMarkdownFiles(entryPath));
    } else if (entry.name.endsWith(".md") || entry.name.endsWith(".mdx")) {
      files.push(entryPath);
    }
  }

  return files;
}

function stripMarkdownCodeBlocks(content) {
  const lines = content.split(/\r?\n/);
  const keptLines = [];
  let inFence = false;
  let fenceMarker = "";

  for (const line of lines) {
    const fence = line.match(/^\s*(```+|~~~+)/)?.[1];
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[0];
      } else if (fence[0] === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }

    if (!inFence) {
      keptLines.push(line);
    }
  }

  return keptLines.join("\n");
}

function createHeadingSlugger() {
  const occurrences = new Map();
  const asciiPunctuation =
    /[\0-\x1F!-,.\/:-@\[-\^`{-~]/g;

  return (value) => {
    const originalSlug = value
      .trim()
      .replace(/<[^>]*>/g, "")
      .toLowerCase()
      .replace(asciiPunctuation, "")
      .replace(/ /g, "-");
    let slug = originalSlug;

    if (occurrences.has(slug)) {
      const count = occurrences.get(originalSlug) + 1;
      occurrences.set(originalSlug, count);
      slug = `${originalSlug}-${count}`;
    }

    occurrences.set(slug, 0);
    return slug;
  };
}

function collectMarkdownAnchors(file) {
  const slug = createHeadingSlugger();
  const content = stripMarkdownCodeBlocks(readFileSync(file, "utf-8"));
  const anchors = new Set();
  const headingPattern = /^#{1,6}\s+(.+)$/gm;
  let match;

  while ((match = headingPattern.exec(content)) !== null) {
    anchors.add(slug(match[1]));
  }

  return anchors;
}

function decodeAnchor(anchor) {
  try {
    return decodeURIComponent(anchor).toLowerCase();
  } catch {
    return anchor.toLowerCase();
  }
}

function extractAnchor(href) {
  const hashIndex = href.indexOf("#");
  if (hashIndex === -1) return null;

  const anchor = href.slice(hashIndex + 1).split("?")[0];
  return anchor ? decodeAnchor(anchor) : null;
}

function internalTargetPath(target) {
  const cleanTarget = target
    .split("#")[0]
    .split("?")[0]
    .replace(/^\/+/, "")
    .replace(/\/$/, "");

  if (!cleanTarget) return DOCS_DIR;

  const candidates = [
    join(DOCS_DIR, `${cleanTarget}.md`),
    join(DOCS_DIR, `${cleanTarget}.mdx`),
    join(DOCS_DIR, cleanTarget, "index.md"),
    join(DOCS_DIR, cleanTarget, "index.mdx"),
    join(DOCS_DIR, cleanTarget),
  ];

  return candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
}

function internalTargetExists(target) {
  return Boolean(internalTargetPath(target));
}

function resolveInternalTarget(sourceFile, href) {
  if (
    !href ||
    href.startsWith("#") ||
    href.startsWith("mailto:") ||
    /^[a-z][a-z0-9+.-]*:/i.test(href)
  ) {
    return null;
  }

  if (href.startsWith("/")) {
    return href;
  }

  const target = relative(DOCS_DIR, resolve(dirname(sourceFile), href));
  return target.startsWith("..") ? null : target;
}

describe("docs.json configuration", () => {
  it("docs.json exists and is valid JSON", () => {
    const docsJsonPath = join(DOCS_DIR, "docs.json");
    assert.ok(existsSync(docsJsonPath), "docs.json should exist");
    const content = readFileSync(docsJsonPath, "utf-8");
    const config = JSON.parse(content);
    assert.ok(
      typeof config === "object" && config !== null,
      "should be a valid object",
    );
  });

  it("has required Mintlify configuration fields", () => {
    const config = JSON.parse(
      readFileSync(join(DOCS_DIR, "docs.json"), "utf-8"),
    );
    assert.ok(config.name, "should have name");
    assert.ok(config.colors, "should have colors");
    assert.ok(config.navigation, "should have navigation");
  });

  it("has valid theme", () => {
    const config = JSON.parse(
      readFileSync(join(DOCS_DIR, "docs.json"), "utf-8"),
    );
    assert.ok(config.theme, "should have theme");
    const validThemes = ["mint", "quill", "venus", "prism"];
    assert.ok(
      validThemes.includes(config.theme),
      `theme "${config.theme}" should be a valid Mintlify theme`,
    );
  });

  it("has valid color configuration", () => {
    const config = JSON.parse(
      readFileSync(join(DOCS_DIR, "docs.json"), "utf-8"),
    );
    assert.ok(config.colors.primary, "should have primary color");
    assert.match(
      config.colors.primary,
      /^#[0-9A-Fa-f]{6}$/,
      "primary color should be valid hex",
    );
  });

  it("navigation tabs are defined", () => {
    const config = JSON.parse(
      readFileSync(join(DOCS_DIR, "docs.json"), "utf-8"),
    );
    assert.ok(config.navigation, "should have navigation");
    assert.ok(
      config.navigation.tabs || config.navigation.global,
      "should have tabs or global navigation",
    );
  });
});

describe("documentation files", () => {
  it("index.mdx exists", () => {
    assert.ok(
      existsSync(join(DOCS_DIR, "index.mdx")),
      "index.mdx should exist",
    );
  });

  it("quickstart.mdx exists", () => {
    assert.ok(
      existsSync(join(DOCS_DIR, "quickstart.mdx")),
      "quickstart.mdx should exist",
    );
  });

  it("core documentation pages referenced in navigation exist", () => {
    const config = JSON.parse(
      readFileSync(join(DOCS_DIR, "docs.json"), "utf-8"),
    );

    function extractPages(obj) {
      const pages = [];
      if (Array.isArray(obj)) {
        for (const item of obj) {
          if (typeof item === "string") {
            pages.push(item);
          } else {
            pages.push(...extractPages(item));
          }
        }
      } else if (obj && typeof obj === "object") {
        if (obj.pages) pages.push(...extractPages(obj.pages));
        if (obj.groups) pages.push(...extractPages(obj.groups));
        if (obj.tabs) pages.push(...extractPages(obj.tabs));
      }
      return pages;
    }

    const pages = extractPages(config.navigation);
    const missingPages = [];
    for (const page of pages) {
      if (typeof page !== "string") continue;
      if (page.startsWith("http")) continue;
      const mdxPath = join(DOCS_DIR, `${page}.mdx`);
      const mdPath = join(DOCS_DIR, `${page}.md`);
      if (!existsSync(mdxPath) && !existsSync(mdPath)) {
        missingPages.push(page);
      }
    }
    assert.strictEqual(
      missingPages.length,
      0,
      `Missing documentation pages: ${missingPages.join(", ")}`,
    );
  });

  it("documentation directories exist", () => {
    const expectedDirs = ["guides", "examples", "runtime", "plugins"];
    for (const dir of expectedDirs) {
      assert.ok(
        existsSync(join(DOCS_DIR, dir)),
        `${dir}/ directory should exist`,
      );
    }
  });

  it(".mdx files have content", () => {
    const mdxFiles = readdirSync(DOCS_DIR).filter((f) => f.endsWith(".mdx"));
    for (const file of mdxFiles) {
      const content = readFileSync(join(DOCS_DIR, file), "utf-8");
      assert.ok(content.trim().length > 0, `${file} should not be empty`);
    }
  });

  it("internal documentation links resolve", () => {
    const markdownFiles = collectMarkdownFiles();
    const missingLinks = [];
    const linkPattern = /\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)|href=["']([^"']+)["']/g;

    for (const file of markdownFiles) {
      const content = stripMarkdownCodeBlocks(readFileSync(file, "utf-8"));
      let match;

      while ((match = linkPattern.exec(content)) !== null) {
        const href = match[1] || match[2];
        const target = resolveInternalTarget(file, href);

        if (target && !internalTargetExists(target)) {
          missingLinks.push(`${relative(DOCS_DIR, file)} -> ${href}`);
        }
      }
    }

    assert.deepStrictEqual(missingLinks, []);
  });

  it("internal documentation anchor links resolve", () => {
    const markdownFiles = collectMarkdownFiles();
    const anchorsByFile = new Map();
    const missingAnchors = [];
    const linkPattern = /\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)|href=["']([^"']+)["']/g;

    function getAnchors(file) {
      if (!anchorsByFile.has(file)) {
        anchorsByFile.set(file, collectMarkdownAnchors(file));
      }
      return anchorsByFile.get(file);
    }

    for (const file of markdownFiles) {
      const content = stripMarkdownCodeBlocks(readFileSync(file, "utf-8"));
      let match;

      while ((match = linkPattern.exec(content)) !== null) {
        const href = match[1] || match[2];
        const anchor = extractAnchor(href);
        if (!anchor) continue;

        let targetPath;
        if (href.startsWith("#")) {
          targetPath = file;
        } else {
          const target = resolveInternalTarget(file, href);
          if (!target) continue;
          targetPath = internalTargetPath(target);
        }

        if (targetPath && !getAnchors(targetPath).has(anchor)) {
          missingAnchors.push(
            `${relative(DOCS_DIR, file)} -> ${href}`,
          );
        }
      }
    }

    assert.deepStrictEqual(missingAnchors, []);
  });
});
