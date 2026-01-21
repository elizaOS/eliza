#!/usr/bin/env bun
/**
 * Build script for elizaos CLI
 * - Scans examples directory to generate manifest
 * - Compiles TypeScript to JavaScript
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT_DIR = path.resolve(import.meta.dir, "../..");
const EXAMPLES_DIR = path.join(ROOT_DIR, "examples");
const PACKAGE_DIR = import.meta.dir;
const DIST_DIR = path.join(PACKAGE_DIR, "dist");

interface ExampleLanguage {
  language: string;
  path: string;
  hasPackageJson?: boolean;
  hasRequirementsTxt?: boolean;
  hasCargoToml?: boolean;
  hasPyprojectToml?: boolean;
}

interface Example {
  name: string;
  description: string;
  path: string;
  languages: ExampleLanguage[];
  category: string;
}

interface ExamplesManifest {
  version: string;
  generatedAt: string;
  repoUrl: string;
  examples: Example[];
  categories: string[];
  languages: string[];
}

// Categories and their descriptions
const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  plugin: "Plugin starter templates",
  _plugin: "Plugin starter templates",
  chat: "Interactive CLI chat applications",
  "text-adventure": "Text adventure games with AI decision making",
  "tic-tac-toe": "Tic-tac-toe game demonstrations",
  "rest-api": "REST API server implementations",
  a2a: "Agent-to-Agent communication examples",
  mcp: "Model Context Protocol examples",
  html: "Browser-based examples",
  react: "React web application examples",
  "react-wasm": "React with WASM integration",
  next: "Next.js application examples",
  aws: "AWS Lambda deployment examples",
  gcp: "Google Cloud Platform examples",
  cloudflare: "Cloudflare Workers examples",
  vercel: "Vercel Edge Function examples",
  supabase: "Supabase Edge Function examples",
};

// Map internal directory names to display names
const EXAMPLE_DISPLAY_NAMES: Record<string, string> = {
  _plugin: "plugin",
};

// Language display names
const _LANGUAGE_NAMES: Record<string, string> = {
  typescript: "TypeScript",
  python: "Python",
  rust: "Rust",
  "rust-wasm": "Rust (WASM)",
};

// Known languages - filter only these
const KNOWN_LANGUAGES = new Set([
  "typescript",
  "python",
  "rust",
  "rust-wasm",
  // REST API frameworks (TypeScript)
  "express",
  "hono",
  "elysia",
  // REST API frameworks (Python)
  "fastapi",
  "flask",
  // REST API frameworks (Rust)
  "actix",
  "axum",
  "rocket",
]);

// Map framework names to their base language
const _FRAMEWORK_TO_LANGUAGE: Record<string, string> = {
  express: "typescript",
  hono: "typescript",
  elysia: "typescript",
  fastapi: "python",
  flask: "python",
  actix: "rust",
  axum: "rust",
  rocket: "rust",
};

// Directories/files to skip when copying examples
const SKIP_PATTERNS = [
  "node_modules",
  ".git",
  "target",
  "__pycache__",
  ".venv",
  "dist",
  ".next",
  ".turbo",
  "*.log",
  "bun.lock",
  "package-lock.json",
  "yarn.lock",
  "Cargo.lock",
];

function shouldSkip(name: string): boolean {
  return SKIP_PATTERNS.some((pattern) => {
    if (pattern.includes("*")) {
      const regex = new RegExp(pattern.replace("*", ".*"));
      return regex.test(name);
    }
    return name === pattern;
  });
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    if (shouldSkip(entry.name)) continue;

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Skip broken symlinks and non-existent files
    if (!fs.existsSync(srcPath)) {
      console.warn(`⚠️  Skipping broken symlink or missing file: ${srcPath}`);
      continue;
    }

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      // For symlinks, copy the target file content instead of the symlink
      const realPath = fs.realpathSync(srcPath);
      fs.copyFileSync(realPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function copyExamplesDir(src: string, dest: string, examples: Example[]): void {
  fs.mkdirSync(dest, { recursive: true });

  for (const example of examples) {
    // Use category (original directory name) for source, name (display name) for destination
    const srcDirName = example.category; // e.g., "_plugin"
    const destDirName = example.name; // e.g., "plugin"
    const srcExample = path.join(src, srcDirName);
    const destExample = path.join(dest, destDirName);

    if (fs.existsSync(srcExample)) {
      copyDir(srcExample, destExample);
    }
  }
}

function getExampleDescription(name: string): string {
  // Try to read README for description
  const readmePath = path.join(EXAMPLES_DIR, name, "README.md");
  if (fs.existsSync(readmePath)) {
    const content = fs.readFileSync(readmePath, "utf-8");
    const lines = content.split("\n");
    // Find first non-empty, non-heading line
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("```")) {
        return trimmed.slice(0, 100);
      }
    }
  }
  return CATEGORY_DESCRIPTIONS[name] || `${name} example`;
}

function detectLanguage(langDir: string): ExampleLanguage | null {
  const langPath = langDir;
  const langName = path.basename(langDir);

  // Only accept known languages/frameworks
  if (!KNOWN_LANGUAGES.has(langName)) {
    return null;
  }

  if (!fs.existsSync(langPath) || !fs.statSync(langPath).isDirectory()) {
    return null;
  }

  const hasPackageJson = fs.existsSync(path.join(langPath, "package.json"));
  const hasRequirementsTxt = fs.existsSync(
    path.join(langPath, "requirements.txt"),
  );
  let hasCargoToml = fs.existsSync(path.join(langPath, "Cargo.toml"));
  const hasPyprojectToml = fs.existsSync(path.join(langPath, "pyproject.toml"));

  // Check for source files even if no project file
  const files = fs.readdirSync(langPath);
  const hasTsFiles = files.some((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
  const hasPyFiles = files.some((f) => f.endsWith(".py"));
  let hasRsFiles =
    files.some((f) => f.endsWith(".rs")) ||
    fs.existsSync(path.join(langPath, "src"));

  // For Rust, also check subdirectories for Cargo.toml (workspace structure)
  if (langName === "rust" && !hasCargoToml) {
    for (const file of files) {
      const subPath = path.join(langPath, file);
      if (fs.statSync(subPath).isDirectory()) {
        if (fs.existsSync(path.join(subPath, "Cargo.toml"))) {
          hasCargoToml = true;
          hasRsFiles = true;
          break;
        }
      }
    }
  }

  // Skip if no valid project files
  const hasAnyProjectFile =
    hasPackageJson || hasRequirementsTxt || hasCargoToml || hasPyprojectToml;

  if (!hasAnyProjectFile && !hasTsFiles && !hasPyFiles && !hasRsFiles) {
    return null;
  }

  return {
    language: langName, // Keep the framework name for path resolution
    path: langPath,
    hasPackageJson,
    hasRequirementsTxt,
    hasCargoToml,
    hasPyprojectToml,
  };
}

function scanExamples(): ExamplesManifest {
  const examples: Example[] = [];
  const categoriesSet = new Set<string>();
  const languagesSet = new Set<string>();

  const entries = fs.readdirSync(EXAMPLES_DIR);

  for (const entry of entries) {
    const examplePath = path.join(EXAMPLES_DIR, entry);
    const stat = fs.statSync(examplePath);

    if (!stat.isDirectory()) continue;
    if (entry.startsWith(".")) continue;

    // Check if this is a category with language subdirs
    const subEntries = fs.readdirSync(examplePath);
    const languages: ExampleLanguage[] = [];

    // Check for language-specific subdirectories
    for (const subEntry of subEntries) {
      const subPath = path.join(examplePath, subEntry);
      if (!fs.statSync(subPath).isDirectory()) continue;

      const lang = detectLanguage(subPath);
      if (lang) {
        languages.push(lang);
        languagesSet.add(lang.language);
      }
    }

    // Also check if the example itself is a standalone project (like html, react, next)
    if (languages.length === 0) {
      const hasPackageJson = fs.existsSync(
        path.join(examplePath, "package.json"),
      );
      const hasRequirementsTxt = fs.existsSync(
        path.join(examplePath, "requirements.txt"),
      );
      const hasCargoToml = fs.existsSync(path.join(examplePath, "Cargo.toml"));
      const hasPyprojectToml = fs.existsSync(
        path.join(examplePath, "pyproject.toml"),
      );

      const files = fs.readdirSync(examplePath);

      if (
        files.some((f) => f.endsWith(".ts") || f.endsWith(".tsx")) ||
        hasPackageJson
      ) {
        languages.push({
          language: "typescript",
          path: examplePath,
          hasPackageJson,
          hasRequirementsTxt: false,
          hasCargoToml: false,
          hasPyprojectToml: false,
        });
        languagesSet.add("typescript");
      } else if (
        files.some((f) => f.endsWith(".py")) ||
        hasRequirementsTxt ||
        hasPyprojectToml
      ) {
        languages.push({
          language: "python",
          path: examplePath,
          hasPackageJson: false,
          hasRequirementsTxt,
          hasCargoToml: false,
          hasPyprojectToml,
        });
        languagesSet.add("python");
      } else if (hasCargoToml) {
        languages.push({
          language: "rust",
          path: examplePath,
          hasPackageJson: false,
          hasRequirementsTxt: false,
          hasCargoToml,
          hasPyprojectToml: false,
        });
        languagesSet.add("rust");
      }
    }

    if (languages.length > 0) {
      // Use display name if available (e.g., "_plugin" -> "plugin")
      const displayName = EXAMPLE_DISPLAY_NAMES[entry] || entry;

      examples.push({
        name: displayName,
        description: getExampleDescription(entry),
        path: examplePath,
        languages,
        category: entry, // Keep original directory name for path resolution
      });
      categoriesSet.add(displayName);
    }
  }

  // Sort examples with "plugin" first, then alphabetically
  const sortedExamples = examples.sort((a, b) => {
    if (a.name === "plugin") return -1;
    if (b.name === "plugin") return 1;
    return a.name.localeCompare(b.name);
  });

  return {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    repoUrl: "https://github.com/elizaos/eliza",
    examples: sortedExamples,
    categories: Array.from(categoriesSet).sort(),
    languages: Array.from(languagesSet).sort(),
  };
}

async function main() {
  console.log("🔍 Scanning examples directory...");
  const manifest = scanExamples();

  console.log(
    `📦 Found ${manifest.examples.length} examples with ${manifest.languages.length} languages`,
  );

  // Write manifest
  const manifestPath = path.join(PACKAGE_DIR, "examples-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`✅ Generated ${manifestPath}`);

  // Create dist directory
  if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
  }

  // Copy manifest to dist
  fs.copyFileSync(manifestPath, path.join(DIST_DIR, "examples-manifest.json"));

  // Copy examples to package for bundling
  const pkgExamplesDir = path.join(PACKAGE_DIR, "examples");
  if (fs.existsSync(pkgExamplesDir)) {
    fs.rmSync(pkgExamplesDir, { recursive: true, force: true });
  }

  console.log("📦 Bundling examples...");
  copyExamplesDir(EXAMPLES_DIR, pkgExamplesDir, manifest.examples);

  // Compile TypeScript
  console.log("🔨 Compiling TypeScript...");
  // Use bunx to run tsc without workspace resolution
  execSync("bunx --bun tsc -p tsconfig.json", {
    cwd: PACKAGE_DIR,
    stdio: "inherit",
  });
  console.log("✅ TypeScript compilation complete");

  // Make CLI executable
  const cliPath = path.join(DIST_DIR, "cli.js");
  if (fs.existsSync(cliPath)) {
    // Add shebang if not present
    let content = fs.readFileSync(cliPath, "utf-8");
    if (!content.startsWith("#!")) {
      content = `#!/usr/bin/env node\n${content}`;
      fs.writeFileSync(cliPath, content);
    }
    fs.chmodSync(cliPath, 0o755);
    console.log("✅ CLI is ready");
  }

  console.log("\n🎉 Build complete!");
  console.log(
    `   Examples: ${manifest.examples.map((e) => e.name).join(", ")}`,
  );
  console.log(`   Languages: ${manifest.languages.join(", ")}`);
}

main().catch(console.error);
