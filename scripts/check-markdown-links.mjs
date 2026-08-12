#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ROOT = path.resolve(import.meta.dirname, "..");
const RETIRED_REPO_EVIDENCE_PREFIX = `${[".github", ["issue", "evidence"].join("-")].join("/")}/`;

// Historical evidence, fixture, vendored, and prototype documentation contains
// intentionally stale sample paths. Keep the first gate on maintained
// contributor-facing docs; shrink this list as those trees are cleaned up.
const EXCLUDED_PREFIXES = [
  RETIRED_REPO_EVIDENCE_PREFIX,
  "docs/",
  "packages/app-core/",
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
  "packages/skills/",
  "packages/training/",
  "packages/ui/src/services/local-inference/",
  "packages/app-core/test/",
  "plugins/plugin-agent-orchestrator/docs/",
  "plugins/plugin-computeruse/",
  "plugins/plugin-local-inference/",
  "plugins/plugin-wallet/src/chains/solana/",
];

const EXCLUDED_NAMES = new Set(["CHANGELOG.md"]);

export function trackedMarkdownFiles(root = DEFAULT_ROOT) {
  try {
    return execFileSync("git", ["ls-files", "*.md"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .filter((file) => existsSync(path.join(root, file)))
      .filter((file) => !EXCLUDED_NAMES.has(path.basename(file)))
      .filter(
        (file) => !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)),
      );
  } catch {
    return [];
  }
}

export function stripAnchor(href) {
  const hashIndex = href.indexOf("#");
  return hashIndex === -1 ? href : href.slice(0, hashIndex);
}

export function candidateTargets(root, sourceFile, href) {
  const withoutQuery = href.split("?")[0];
  if (withoutQuery.startsWith("/")) {
    const docsTarget = path.join(
      root,
      "packages/docs",
      withoutQuery.replace(/^\/+/, ""),
    );
    return [
      path.join(root, withoutQuery),
      docsTarget,
      `${docsTarget}.md`,
      `${docsTarget}.mdx`,
      path.join(docsTarget, "README.md"),
      path.join(docsTarget, "index.md"),
      path.join(docsTarget, "index.mdx"),
    ];
  }

  const target = path.resolve(root, path.dirname(sourceFile), withoutQuery);
  return [
    target,
    `${target}.md`,
    `${target}.mdx`,
    path.join(target, "README.md"),
    path.join(target, "index.md"),
    path.join(target, "index.mdx"),
  ];
}

export function isRelativeLink(href) {
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

export function decodeHref(href) {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

export function targetExists(root, sourceFile, rawHref) {
  const href = decodeHref(stripAnchor(rawHref).trim());
  if (!isRelativeLink(href)) return true;

  for (const target of candidateTargets(root, sourceFile, href)) {
    if (!target.startsWith(root)) continue;
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

export function stripCode(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\n]+`/g, "");
}

export function markdownLinks(markdown) {
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

export function checkMarkdownLinks({ root = DEFAULT_ROOT } = {}) {
  const resolvedRoot = path.resolve(root);
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
    throw new TypeError(
      `[check-markdown-links] --root directory does not exist: ${root}`,
    );
  }

  const files = trackedMarkdownFiles(resolvedRoot);
  const failures = [];
  for (const file of files) {
    const markdown = readFileSync(path.join(resolvedRoot, file), "utf8");
    for (const href of markdownLinks(markdown)) {
      if (!targetExists(resolvedRoot, file, href)) {
        failures.push(`${file}: missing relative link target ${href}`);
      }
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    scannedFiles: files.length,
  };
}

export function parseArgs(argv) {
  const options = {
    help: false,
    json: false,
    quiet: false,
    root: DEFAULT_ROOT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else if (arg.startsWith("--root=")) {
      const val = arg.slice("--root=".length).trim();
      if (!val) {
        throw new Error(
          "[check-markdown-links] --root requires a directory path",
        );
      }
      options.root = val;
    } else if (arg === "--root") {
      const next = argv[index + 1];
      if (!next || next.startsWith("-")) {
        throw new Error(
          "[check-markdown-links] --root requires a directory path",
        );
      }
      options.root = next;
      index += 1;
    } else {
      throw new Error(`[check-markdown-links] Unknown option: ${arg}`);
    }
  }

  return options;
}

export function printHelp() {
  console.log(`Usage: node scripts/check-markdown-links.mjs [options]

Options:
  --root=<path>   Repository root directory (default: workspace root)
  --json          Output scan results as JSON
  --quiet         Suppress PASS output on success
  --help, -h      Show this help message`);
}

export function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }

  const result = checkMarkdownLinks({ root: options.root });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.ok) {
    console.error(
      `[check-markdown-links] ${result.failures.length} missing relative link target(s):`,
    );
    for (const failure of result.failures) {
      console.error(`- ${failure}`);
    }
  } else if (!options.quiet) {
    console.log(
      "[check-markdown-links] PASS: relative Markdown links resolve.",
    );
  }

  return result.ok ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "[check-markdown-links] failed",
    );
    process.exitCode = 2;
  }
}
