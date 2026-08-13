/**
 * Docs site integrity tests for Mintlify navigation, metadata, and links.
 *
 * Runs against the real files on disk so docs.json, redirects, frontmatter,
 * local assets, and internal links stay deployable together.
 */

import assert from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, "..");
const REPO_ROOT = resolve(DOCS_DIR, "../..");
const DOCS_JSON_PATH = join(DOCS_DIR, "docs.json");
const CLOUD_ROUTER_PATH = join(
  REPO_ROOT,
  "packages/cloud/api/src/_router.generated.ts",
);

function readDocsConfig() {
  return JSON.parse(readFileSync(DOCS_JSON_PATH, "utf-8"));
}

function normalizeRoute(route) {
  const cleanRoute = route
    .replaceAll("\\", "/")
    .split("#")[0]
    .split("?")[0]
    .replace(/^\/+/, "")
    .replace(/\/$/, "")
    .replace(/\.mdx?$/, "");

  return cleanRoute;
}

function collectRedirects(config = readDocsConfig()) {
  const redirects = new Map();

  for (const redirect of config.redirects ?? []) {
    redirects.set(normalizeRoute(redirect.source), redirect.destination);
  }

  return redirects;
}

function collectPages(obj) {
  if (Array.isArray(obj)) {
    return obj.flatMap((item) =>
      typeof item === "string" ? [item] : collectPages(item),
    );
  }

  if (!obj || typeof obj !== "object") {
    return [];
  }

  return [
    ...collectPages(obj.pages),
    ...collectPages(obj.groups),
    ...collectPages(obj.tabs),
  ];
}

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    } else {
      seen.add(value);
    }
  }

  return [...duplicates];
}

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

function collectContentFiles() {
  const packageFiles = new Set(["AGENTS.md", "CLAUDE.md", "README.md"]);
  return collectMarkdownFiles().filter(
    (file) => !packageFiles.has(relative(DOCS_DIR, file)),
  );
}

function internalTargetExists(target) {
  const cleanTarget = normalizeRoute(target);

  if (!cleanTarget) return true;

  const candidates = [
    join(DOCS_DIR, cleanTarget),
    join(DOCS_DIR, `${cleanTarget}.md`),
    join(DOCS_DIR, `${cleanTarget}.mdx`),
    join(DOCS_DIR, cleanTarget, "index.md"),
    join(DOCS_DIR, cleanTarget, "index.mdx"),
  ];

  return candidates.some(existsSync);
}

function localAssetExists(target) {
  const cleanTarget = normalizeRoute(target);

  if (!cleanTarget) return true;

  return [
    join(DOCS_DIR, cleanTarget),
    join(DOCS_DIR, "public", cleanTarget),
  ].some(existsSync);
}

function internalTargetOrRedirectExists(
  target,
  redirects = collectRedirects(),
) {
  if (internalTargetExists(target)) {
    return true;
  }

  const destination = redirects.get(normalizeRoute(target));
  return destination ? internalTargetExists(destination) : false;
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

function extractMarkdownFrontmatter(content) {
  const opening = /^---(\r?\n)/.exec(content);
  if (!opening) {
    return null;
  }

  const bodyStart = opening[0].length;
  const end = content.indexOf(`${opening[1]}---`, bodyStart);
  if (end === -1) {
    return { closed: false, body: content.slice(bodyStart) };
  }

  return { closed: true, body: content.slice(bodyStart, end) };
}

describe("docs integrity helpers", () => {
  it("normalizes Windows path separators", () => {
    assert.strictEqual(
      normalizeRoute("tracks\\agent\\lifecycle.mdx"),
      "tracks/agent/lifecycle",
    );
  });

  it("extracts frontmatter with LF and CRLF line endings", () => {
    for (const newline of ["\n", "\r\n"]) {
      const content = `---${newline}title: Example${newline}description: Test${newline}---${newline}Body`;

      assert.deepStrictEqual(extractMarkdownFrontmatter(content), {
        closed: true,
        body: `title: Example${newline}description: Test`,
      });
    }
  });
});

describe("docs.json configuration", () => {
  it("docs.json exists and is valid JSON", () => {
    assert.ok(existsSync(DOCS_JSON_PATH), "docs.json should exist");
    const config = readDocsConfig();
    assert.ok(
      typeof config === "object" && config !== null,
      "should be a valid object",
    );
  });

  it("has required Mintlify configuration fields", () => {
    const config = readDocsConfig();
    assert.ok(config.name, "should have name");
    assert.ok(config.colors, "should have colors");
    assert.ok(config.navigation, "should have navigation");
  });

  it("has valid theme", () => {
    const config = readDocsConfig();
    assert.ok(config.theme, "should have theme");
    const validThemes = ["mint", "quill", "venus", "prism"];
    assert.ok(
      validThemes.includes(config.theme),
      `theme "${config.theme}" should be a valid Mintlify theme`,
    );
  });

  it("has valid color configuration", () => {
    const config = readDocsConfig();
    assert.ok(config.colors.primary, "should have primary color");
    assert.match(
      config.colors.primary,
      /^#[0-9A-Fa-f]{6}$/,
      "primary color should be valid hex",
    );
  });

  it("navigation tabs are defined", () => {
    const config = readDocsConfig();
    assert.ok(config.navigation, "should have navigation");
    assert.ok(
      config.navigation.tabs || config.navigation.global,
      "should have tabs or global navigation",
    );
  });

  it("navigation tabs and groups do not duplicate labels", () => {
    const config = readDocsConfig();
    const tabs = config.navigation.tabs ?? [];
    const duplicateTabs = findDuplicates(tabs.map((tab) => tab.tab));

    assert.deepStrictEqual(duplicateTabs, []);

    for (const tab of tabs) {
      const groups = tab.groups ?? [];
      const duplicateGroups = findDuplicates(
        groups.map((group) => group.group),
      );

      assert.deepStrictEqual(
        duplicateGroups,
        [],
        `Duplicate group labels in tab "${tab.tab}"`,
      );
    }
  });

  it("navigation groups do not list the same page twice", () => {
    const config = readDocsConfig();

    for (const tab of config.navigation.tabs ?? []) {
      for (const group of tab.groups ?? []) {
        const pages = collectPages(group.pages ?? []);
        const duplicatePages = findDuplicates(pages);

        assert.deepStrictEqual(
          duplicatePages,
          [],
          `Duplicate pages in ${tab.tab} / ${group.group}`,
        );
      }
    }
  });

  it("redirects resolve to real pages without loops or fragments", () => {
    const config = readDocsConfig();
    const redirects = config.redirects ?? [];

    assert.deepStrictEqual(
      findDuplicates(
        redirects.map((redirect) => normalizeRoute(redirect.source)),
      ),
      [],
      "Redirect sources must be unique",
    );

    for (const redirect of redirects) {
      assert.ok(redirect.source, "redirect should include a source");
      assert.ok(redirect.destination, "redirect should include a destination");
      assert.ok(
        !/[?#]/.test(redirect.source),
        `redirect source cannot include query or hash: ${redirect.source}`,
      );
      assert.ok(
        !/[?#]/.test(redirect.destination),
        `redirect destination cannot include query or hash: ${redirect.destination}`,
      );
      assert.notStrictEqual(
        normalizeRoute(redirect.source),
        normalizeRoute(redirect.destination),
        `redirect loops to itself: ${redirect.source}`,
      );
      assert.ok(
        internalTargetExists(redirect.destination),
        `redirect destination should exist: ${redirect.source} -> ${redirect.destination}`,
      );
    }
  });

  it("configured local assets exist", () => {
    const config = readDocsConfig();
    const assetPaths = [
      config.favicon,
      config.logo?.light,
      config.logo?.dark,
      config.seo?.metadata?.["og:image"],
      config.seo?.metadata?.["x:image"],
    ].filter(Boolean);

    for (const assetPath of assetPaths) {
      assert.ok(
        localAssetExists(assetPath),
        `Missing configured asset: ${assetPath}`,
      );
    }
  });
});

describe("documentation files", () => {
  it("does not expose Node test files as Mintlify browser scripts", () => {
    const browserScripts = readdirSync(join(DOCS_DIR, "test")).filter((file) =>
      file.endsWith(".js"),
    );

    assert.deepStrictEqual(
      browserScripts,
      [],
      "Mintlify injects .js files under the docs tree into published pages",
    );
  });

  it("core documentation pages referenced in navigation exist", () => {
    const config = readDocsConfig();
    const pages = collectPages(config.navigation);
    const missingPages = [];

    for (const page of pages) {
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

  it("does not contain hidden content pages outside navigation", () => {
    const config = readDocsConfig();
    const navigationPages = new Set(
      collectPages(config.navigation).map(normalizeRoute),
    );
    const packageFiles = new Set(["AGENTS", "CLAUDE", "README"]);
    const hiddenPages = collectMarkdownFiles()
      .map((file) => normalizeRoute(relative(DOCS_DIR, file)))
      .filter((page) => !packageFiles.has(page) && !navigationPages.has(page));

    assert.deepStrictEqual(
      hiddenPages,
      [],
      "Every content page must appear in docs.json navigation",
    );
  });

  it("documentation directories exist", () => {
    const expectedDirs = ["tracks", "runtime", "plugins", "cli", "cloud"];
    for (const dir of expectedDirs) {
      assert.ok(
        existsSync(join(DOCS_DIR, dir)),
        `${dir}/ directory should exist`,
      );
    }
  });

  it("markdown files have content", () => {
    const markdownFiles = collectMarkdownFiles();
    for (const file of markdownFiles) {
      const content = readFileSync(file, "utf-8");
      const label = relative(DOCS_DIR, file);

      assert.ok(content.trim().length > 0, `${label} should not be empty`);
    }
  });

  it("frontmatter blocks are closed and do not duplicate keys", () => {
    const markdownFiles = collectMarkdownFiles();

    for (const file of markdownFiles) {
      const content = readFileSync(file, "utf-8");
      const frontmatter = extractMarkdownFrontmatter(content);
      const label = relative(DOCS_DIR, file);

      if (!frontmatter) {
        continue;
      }

      assert.ok(frontmatter.closed, `${label} frontmatter should be closed`);

      const keys = [];
      for (const line of frontmatter.body.split("\n")) {
        const match = /^([A-Za-z0-9_-]+):/.exec(line);
        if (match) {
          keys.push(match[1]);
        }
      }

      assert.deepStrictEqual(
        findDuplicates(keys),
        [],
        `${label} frontmatter should not duplicate keys`,
      );
    }
  });

  it("every published page has a title and description", () => {
    for (const file of collectContentFiles()) {
      const content = readFileSync(file, "utf-8");
      const frontmatter = extractMarkdownFrontmatter(content);
      const label = relative(DOCS_DIR, file);

      assert.ok(frontmatter?.closed, `${label} should start with frontmatter`);
      assert.match(
        frontmatter.body,
        /^title:\s*\S.+$/m,
        `${label} needs a title`,
      );
      assert.match(
        frontmatter.body,
        /^description:\s*\S.+$/m,
        `${label} needs a description`,
      );
    }
  });

  it("published page titles are unique", () => {
    const titles = new Map();

    for (const file of collectContentFiles()) {
      const content = readFileSync(file, "utf-8");
      const frontmatter = extractMarkdownFrontmatter(content);
      const title = /^title:\s*["']?(.+?)["']?\s*$/m.exec(
        frontmatter?.body ?? "",
      )?.[1];

      if (!title) continue;
      const files = titles.get(title) ?? [];
      files.push(relative(DOCS_DIR, file));
      titles.set(title, files);
    }

    const duplicates = [...titles.entries()].filter(
      ([, files]) => files.length > 1,
    );
    assert.deepStrictEqual(duplicates, []);
  });

  it("internal documentation links resolve", () => {
    const markdownFiles = collectMarkdownFiles();
    const redirects = collectRedirects();
    const missingLinks = [];
    const linkPattern =
      /\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)|href=["']([^"']+)["']/g;

    for (const file of markdownFiles) {
      const content = readFileSync(file, "utf-8");
      let match = linkPattern.exec(content);

      while (match !== null) {
        const href = match[1] || match[2];
        const target = resolveInternalTarget(file, href);

        if (target && !internalTargetOrRedirectExists(target, redirects)) {
          missingLinks.push(`${relative(DOCS_DIR, file)} -> ${href}`);
        }
        match = linkPattern.exec(content);
      }
    }

    assert.deepStrictEqual(missingLinks, []);
  });

  it("local image and source assets referenced from markdown exist", () => {
    const markdownFiles = collectMarkdownFiles();
    const missingAssets = [];
    const assetPattern =
      /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(?:src|poster)=["']([^"']+)["']/g;

    for (const file of markdownFiles) {
      const content = readFileSync(file, "utf-8");
      let match = assetPattern.exec(content);

      while (match !== null) {
        const href = match[1] || match[2];
        const target = resolveInternalTarget(file, href);

        if (target && !localAssetExists(target)) {
          missingAssets.push(`${relative(DOCS_DIR, file)} -> ${href}`);
        }
        match = assetPattern.exec(content);
      }
    }

    assert.deepStrictEqual(missingAssets, []);
  });

  it("backticked repository source paths exist", () => {
    const missingPaths = [];
    const sourcePathPattern =
      /`((?:packages|plugins|scripts|docs)\/[A-Za-z0-9_@./{}*?<>-]+(?::\d+)?)`/g;

    for (const file of collectMarkdownFiles()) {
      const content = readFileSync(file, "utf-8");
      let match = sourcePathPattern.exec(content);

      while (match !== null) {
        const sourcePath = match[1].replace(/:\d+$/, "");
        const generatedPath =
          sourcePath.includes("/dist/") ||
          sourcePath.endsWith("/dist") ||
          sourcePath.includes("/dist-") ||
          sourcePath.includes("/node_modules/") ||
          sourcePath.endsWith("/node_modules") ||
          sourcePath.startsWith(
            "packages/app-core/platforms/electrobun/artifacts/",
          );
        const externalOsPath = sourcePath.startsWith("packages/os/");
        const illustrativePath = /[{}*?<>]/.test(sourcePath);

        if (
          !generatedPath &&
          !externalOsPath &&
          !illustrativePath &&
          !existsSync(resolve(REPO_ROOT, sourcePath))
        ) {
          missingPaths.push(`${relative(DOCS_DIR, file)} -> ${sourcePath}`);
        }
        match = sourcePathPattern.exec(content);
      }
    }

    assert.deepStrictEqual(missingPaths, []);
  });

  it("GitHub links to this repository resolve to local source paths", () => {
    const missingPaths = [];
    const sourceLinkPattern =
      /https:\/\/github\.com\/elizaOS\/eliza\/(?:blob|tree)\/(?:develop|main)\/([^\s)"'<>#?]+)/g;

    for (const file of collectMarkdownFiles()) {
      const content = readFileSync(file, "utf-8");
      let match = sourceLinkPattern.exec(content);

      while (match !== null) {
        const sourcePath = decodeURIComponent(match[1]).replace(/\/$/, "");
        if (!existsSync(resolve(REPO_ROOT, sourcePath))) {
          missingPaths.push(`${relative(DOCS_DIR, file)} -> ${sourcePath}`);
        }
        match = sourceLinkPattern.exec(content);
      }
    }

    assert.deepStrictEqual(missingPaths, []);
  });

  it("documented bun scripts exist in their target package", () => {
    const missingScripts = [];
    const commandPattern = /^\s*bun run(?: --cwd ([^\s]+))? ([^\s#]+)/gm;

    for (const file of collectMarkdownFiles()) {
      const content = readFileSync(file, "utf-8");
      let match = commandPattern.exec(content);

      while (match !== null) {
        const packageDir = match[1] ?? ".";
        const scriptName = match[2];
        const isFileInvocation =
          scriptName.includes("/") || scriptName.includes(".");
        const isIllustrative = /[<>{}*?]/.test(`${packageDir}${scriptName}`);

        if (!isFileInvocation && !isIllustrative) {
          const packageJsonPath = resolve(
            REPO_ROOT,
            packageDir,
            "package.json",
          );
          if (!existsSync(packageJsonPath)) {
            missingScripts.push(
              `${relative(DOCS_DIR, file)} -> missing ${relative(REPO_ROOT, packageJsonPath)}`,
            );
          } else {
            const packageJson = JSON.parse(
              readFileSync(packageJsonPath, "utf-8"),
            );
            if (!packageJson.scripts?.[scriptName]) {
              missingScripts.push(
                `${relative(DOCS_DIR, file)} -> bun run --cwd ${packageDir} ${scriptName}`,
              );
            }
          }
        }
        match = commandPattern.exec(content);
      }
    }

    assert.deepStrictEqual(missingScripts, []);
  });

  it("documented Eliza Cloud API paths exist in the generated router", () => {
    assert.ok(
      existsSync(CLOUD_ROUTER_PATH),
      "Cloud generated router should exist",
    );
    const routerSource = readFileSync(CLOUD_ROUTER_PATH, "utf-8");
    const mountedRoutes = [
      ...routerSource.matchAll(/app\.route\(\s*"([^"]+)"/g),
    ].map((match) => match[1]);
    const cloudDocsDir = join(DOCS_DIR, "cloud");
    const missingRoutes = [];
    const cloudUrlPattern = /https:\/\/(?:www\.)?elizacloud\.ai([^\s"'`<]+)/g;
    const variableSegment = (segment) =>
      segment.startsWith(":") ||
      segment.startsWith("{") ||
      segment.startsWith("$") ||
      /^(?:doc|mcp|agent|app)_[a-z0-9]+$/i.test(segment) ||
      /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment);
    const routeMatches = (documentedPath, mountedPath) => {
      const documentedSegments = documentedPath.split("/").filter(Boolean);
      const mountedSegments = mountedPath.split("/").filter(Boolean);
      return (
        documentedSegments.length === mountedSegments.length &&
        documentedSegments.every(
          (segment, index) =>
            variableSegment(segment) ||
            variableSegment(mountedSegments[index]) ||
            segment === mountedSegments[index],
        )
      );
    };

    for (const file of collectMarkdownFiles(cloudDocsDir)) {
      const content = readFileSync(file, "utf-8");
      let match = cloudUrlPattern.exec(content);

      while (match !== null) {
        const documentedPath = match[1]
          .split("?")[0]
          .replace(/[),.;]+$/, "")
          .replace(/\/$/, "");
        const isApiEndpoint =
          documentedPath.startsWith("/api/") && documentedPath !== "/api/v1";

        if (
          isApiEndpoint &&
          !mountedRoutes.some((route) => routeMatches(documentedPath, route))
        ) {
          missingRoutes.push(
            `${relative(DOCS_DIR, file)} -> ${documentedPath}`,
          );
        }
        match = cloudUrlPattern.exec(content);
      }
    }

    assert.deepStrictEqual(missingRoutes, []);
  });
});
