#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

// Historical evidence, fixture, vendored, and prototype documentation contains
// intentionally stale sample paths. Keep the first gate on maintained
// contributor-facing docs; shrink this list as those trees are cleaned up.
const EXCLUDED_PREFIXES = [
  ".github/issue-evidence/",
  "docs/",
  "packages/app-core/",
  "packages/benchmarks/",
  "packages/cloud/",
  "packages/docs/apps/",
  "packages/docs/build-and-release.md",
  "packages/docs/connectors/",
  "packages/docs/dashboard/",
  "packages/docs/electrobun-startup.md",
  "packages/docs/plugin-resolution-and-node-path.md",
  "packages/docs/plugins/",
  "packages/docs/runtime/",
  "packages/elizaos/src/commands/",
  "packages/examples/",
  "packages/feed/",
  "packages/research/",
  "packages/security/docs/",
  "packages/skills/",
  "packages/training/",
  "packages/ui/src/services/local-inference/",
  "packages/app-core/test/",
  "plugins/plugin-agent-orchestrator/docs/",
  "plugins/plugin-computeruse/",
  "plugins/plugin-local-inference/",
  "plugins/plugin-wallet/src/chains/solana/",
  "plugins/plugin-xai/",
];

const EXCLUDED_NAMES = new Set(["CHANGELOG.md"]);

function trackedMarkdownFiles() {
  return execFileSync("git", ["ls-files", "*.md"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .filter((file) => !EXCLUDED_NAMES.has(path.basename(file)))
    .filter(
      (file) => !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)),
    );
}

function stripAnchor(href) {
  const hashIndex = href.indexOf("#");
  return hashIndex === -1 ? href : href.slice(0, hashIndex);
}

function candidateTargets(sourceFile, href) {
  const withoutQuery = href.split("?")[0];
  if (withoutQuery.startsWith("/")) {
    const docsTarget = path.join(
      ROOT,
      "packages/docs",
      withoutQuery.replace(/^\/+/, ""),
    );
    return [
      path.join(ROOT, withoutQuery),
      docsTarget,
      `${docsTarget}.md`,
      `${docsTarget}.mdx`,
      path.join(docsTarget, "README.md"),
      path.join(docsTarget, "index.md"),
      path.join(docsTarget, "index.mdx"),
    ];
  }

  const target = path.resolve(ROOT, path.dirname(sourceFile), withoutQuery);
  return [
    target,
    `${target}.md`,
    `${target}.mdx`,
    path.join(target, "README.md"),
    path.join(target, "index.md"),
    path.join(target, "index.mdx"),
  ];
}

function isRelativeLink(href) {
  return (
    href &&
    !href.startsWith("#") &&
    !href.startsWith("mailto:") &&
    !href.startsWith("tel:") &&
    !href.startsWith("http://") &&
    !href.startsWith("https://") &&
    !href.startsWith("ftp://") &&
    !href.startsWith("file://") &&
    !href.startsWith("data:")
  );
}

function decodeHref(href) {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

function targetExists(sourceFile, rawHref) {
  const href = decodeHref(stripAnchor(rawHref).trim());
  if (!isRelativeLink(href)) return true;

  for (const target of candidateTargets(sourceFile, href)) {
    if (!target.startsWith(ROOT)) continue;
    if (!existsSync(target)) continue;
    if (statSync(target).isDirectory()) {
      if (
        existsSync(path.join(target, "README.md")) ||
        existsSync(path.join(target, "index.md")) ||
        existsSync(path.join(target, "index.mdx"))
      ) {
        return true;
      }
      continue;
    }
    return true;
  }
  return false;
}

function stripCode(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\n]+`/g, "");
}

function markdownLinks(markdown) {
  const links = [];
  const searchable = stripCode(markdown);
  const inlinePattern = /!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const referencePattern = /^\s*\[[^\]\n]+]:\s*(\S+)/gm;
  for (const match of searchable.matchAll(inlinePattern)) {
    links.push(match[1]);
  }
  for (const match of searchable.matchAll(referencePattern)) {
    links.push(match[1]);
  }
  return links;
}

const failures = [];
for (const file of trackedMarkdownFiles()) {
  const markdown = readFileSync(path.join(ROOT, file), "utf8");
  for (const href of markdownLinks(markdown)) {
    if (!targetExists(file, href)) {
      failures.push(`${file}: missing relative link target ${href}`);
    }
  }
}

if (failures.length > 0) {
  console.error(
    `[check-markdown-links] ${failures.length} missing relative link target(s):`,
  );
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[check-markdown-links] PASS: relative Markdown links resolve.");
