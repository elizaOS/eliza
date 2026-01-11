/**
 * Create command - Create a new elizaOS example project
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import {
  getExampleByName,
  getExamplesByLanguage,
  loadManifest,
} from "../manifest.js";
import type { CreateOptions, Example } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Language display names
const LANGUAGE_NAMES: Record<string, string> = {
  typescript: "TypeScript",
  python: "Python",
  rust: "Rust",
  "rust-wasm": "Rust (WASM)",
};

// Category emojis
const CATEGORY_ICONS: Record<string, string> = {
  plugin: "🔧",
  chat: "💬",
  "text-adventure": "🎮",
  "tic-tac-toe": "⭕",
  "rest-api": "🌐",
  a2a: "🤝",
  mcp: "🔌",
  html: "📄",
  react: "⚛️",
  "react-wasm": "🦀",
  next: "▲",
  aws: "☁️",
  gcp: "🌩️",
  cloudflare: "🔶",
  vercel: "▲",
  supabase: "⚡",
};

// Directories/files to skip when copying
const SKIP_PATTERNS = [
  "node_modules",
  ".git",
  "target",
  "__pycache__",
  ".venv",
  "dist",
  ".next",
  ".turbo",
];

function shouldSkip(name: string): boolean {
  return SKIP_PATTERNS.includes(name);
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    if (shouldSkip(entry.name)) continue;

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function findExamplesDir(): string {
  // Try different locations
  const possiblePaths = [
    // When installed as package
    path.join(__dirname, "..", "..", "examples"),
    path.join(__dirname, "..", "examples"),
    // During development
    path.join(__dirname, "..", "..", "..", "examples"),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  throw new Error("Could not find examples directory");
}

function fixPackageJson(filePath: string): void {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf-8");
  const pkg = JSON.parse(content) as Record<string, unknown>;

  // Fix workspace:* references in dependencies
  const fixDeps = (deps: Record<string, string> | undefined) => {
    if (!deps) return;
    for (const [key, value] of Object.entries(deps)) {
      if (value === "workspace:*") {
        // Replace with latest version
        deps[key] = "^1.0.0";
      }
    }
  };

  fixDeps(pkg.dependencies as Record<string, string> | undefined);
  fixDeps(pkg.devDependencies as Record<string, string> | undefined);
  fixDeps(pkg.peerDependencies as Record<string, string> | undefined);

  // Remove private flag so the project can be published if desired
  delete pkg.private;

  fs.writeFileSync(filePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

function copyExample(
  exampleName: string,
  language: string,
  destination: string,
): void {
  const examplesDir = findExamplesDir();
  const examplePath = path.join(examplesDir, exampleName);

  if (!fs.existsSync(examplePath)) {
    throw new Error(`Example '${exampleName}' not found`);
  }

  // Check for language-specific subdirectory
  const langPath = path.join(examplePath, language);

  if (fs.existsSync(langPath)) {
    // Copy the language-specific folder
    copyDir(langPath, destination);
  } else {
    // Copy the entire example (for standalone examples like html, react)
    copyDir(examplePath, destination);
  }

  // Fix workspace references in package.json
  fixPackageJson(path.join(destination, "package.json"));
}

function getStartInstructions(language: string, projectDir: string): string[] {
  const instructions: string[] = [];

  switch (language) {
    case "typescript":
      instructions.push(`cd ${projectDir}`);
      instructions.push("bun install  # or npm install");
      instructions.push("bun run start  # or npm start");
      break;
    case "python":
      instructions.push(`cd ${projectDir}`);
      instructions.push("python -m venv .venv");
      instructions.push(
        "source .venv/bin/activate  # or .venv\\Scripts\\activate on Windows",
      );
      instructions.push("pip install -r requirements.txt");
      instructions.push("python main.py  # or the main script");
      break;
    case "rust":
    case "rust-wasm":
      instructions.push(`cd ${projectDir}`);
      instructions.push("cargo build");
      instructions.push("cargo run");
      break;
    default:
      instructions.push(`cd ${projectDir}`);
  }

  return instructions;
}

export async function create(
  projectName: string | undefined,
  options: CreateOptions,
): Promise<void> {
  const manifest = loadManifest();

  clack.intro(pc.bgCyan(pc.black(" elizaOS ")));

  // Step 1: Select language
  let selectedLanguage = options.language;

  if (!selectedLanguage) {
    const languageChoice = await clack.select({
      message: "Select a language:",
      options: manifest.languages.map((lang) => ({
        value: lang,
        label: LANGUAGE_NAMES[lang] || lang,
        hint: lang,
      })),
    });

    if (clack.isCancel(languageChoice)) {
      clack.cancel("Operation cancelled.");
      process.exit(0);
    }

    selectedLanguage = languageChoice as string;
  }

  // Step 2: Select example
  const availableExamples = getExamplesByLanguage(selectedLanguage);

  if (availableExamples.length === 0) {
    clack.cancel(`No examples available for ${selectedLanguage}`);
    process.exit(1);
  }

  let selectedExample: Example | undefined;

  if (options.example) {
    selectedExample = getExampleByName(options.example);
    if (!selectedExample) {
      clack.cancel(`Example '${options.example}' not found.`);
      process.exit(1);
    }
    // Check if example has the selected language
    if (
      !selectedExample.languages.some((l) => l.language === selectedLanguage)
    ) {
      clack.cancel(
        `Example '${options.example}' is not available in ${selectedLanguage}`,
      );
      process.exit(1);
    }
  } else {
    const exampleChoice = await clack.select({
      message: "Select an example:",
      options: availableExamples.map((ex) => ({
        value: ex.name,
        label: `${CATEGORY_ICONS[ex.name] || "📦"} ${ex.name}`,
        hint: ex.description.slice(0, 50),
      })),
    });

    if (clack.isCancel(exampleChoice)) {
      clack.cancel("Operation cancelled.");
      process.exit(0);
    }

    selectedExample = getExampleByName(exampleChoice as string);
  }

  if (!selectedExample) {
    clack.cancel("Example not found.");
    process.exit(1);
  }

  // Step 3: Get project name
  let finalProjectName = projectName;

  if (!finalProjectName) {
    const nameInput = await clack.text({
      message: "Project name:",
      placeholder: `my-${selectedExample.name}`,
      defaultValue: `my-${selectedExample.name}`,
      validate: (value) => {
        if (!value.trim()) return "Project name is required";
        if (fs.existsSync(value)) return `Directory '${value}' already exists`;
        if (!/^[a-zA-Z0-9-_]+$/.test(value)) {
          return "Project name can only contain letters, numbers, hyphens, and underscores";
        }
        return undefined;
      },
    });

    if (clack.isCancel(nameInput)) {
      clack.cancel("Operation cancelled.");
      process.exit(0);
    }

    finalProjectName = nameInput as string;
  }

  // Validate project name
  if (fs.existsSync(finalProjectName)) {
    clack.cancel(`Directory '${finalProjectName}' already exists.`);
    process.exit(1);
  }

  // Step 4: Confirmation
  if (!options.yes) {
    const confirmed = await clack.confirm({
      message: `Create ${pc.cyan(selectedExample.name)} (${LANGUAGE_NAMES[selectedLanguage] || selectedLanguage}) in ${pc.cyan(finalProjectName)}?`,
    });

    if (clack.isCancel(confirmed) || !confirmed) {
      clack.cancel("Operation cancelled.");
      process.exit(0);
    }
  }

  // Step 5: Download and create project
  const spinner = clack.spinner();
  spinner.start("Creating project...");

  spinner.message(`Copying ${selectedExample.name} (${selectedLanguage})...`);

  // Copy the example
  copyExample(selectedExample.name, selectedLanguage, finalProjectName);

  spinner.stop("Project created successfully!");

  // Show success message and next steps
  console.log();
  clack.note(
    getStartInstructions(selectedLanguage, finalProjectName).join("\n"),
    "Next steps",
  );

  clack.outro(
    `${pc.green("✨")} Your ${selectedExample.name} project is ready!`,
  );
}
