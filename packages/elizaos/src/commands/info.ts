/**
 * Info command - Display information about available examples
 */

import pc from "picocolors";
import { getExamplesByLanguage, loadManifest } from "../manifest.js";
import type { InfoOptions } from "../types.js";

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

export function info(options: InfoOptions): void {
  const manifest = loadManifest();

  // JSON output
  if (options.json) {
    if (options.language) {
      const filtered = getExamplesByLanguage(options.language);
      console.log(JSON.stringify(filtered, null, 2));
    } else {
      console.log(JSON.stringify(manifest, null, 2));
    }
    return;
  }

  console.log();
  console.log(pc.bold(pc.cyan("elizaOS Examples")));
  console.log(pc.dim(`Generated: ${manifest.generatedAt}`));
  console.log();

  // Show languages
  console.log(pc.bold("Available Languages:"));
  for (const lang of manifest.languages) {
    const displayName = LANGUAGE_NAMES[lang] || lang;
    console.log(`  ${pc.green("•")} ${displayName} ${pc.dim(`(${lang})`)}`);
  }
  console.log();

  // Filter by language if specified
  const examples = options.language
    ? getExamplesByLanguage(options.language)
    : manifest.examples;

  if (options.language) {
    console.log(
      pc.bold(
        `Examples for ${LANGUAGE_NAMES[options.language] || options.language}:`,
      ),
    );
  } else {
    console.log(pc.bold("Available Examples:"));
  }
  console.log();

  for (const example of examples) {
    const icon = CATEGORY_ICONS[example.name] || "📦";
    console.log(`  ${icon} ${pc.bold(pc.white(example.name))}`);
    console.log(`     ${pc.dim(example.description)}`);

    const langs = example.languages.map((l) => {
      const name = LANGUAGE_NAMES[l.language] || l.language;
      return pc.cyan(name);
    });
    console.log(`     ${pc.dim("Languages:")} ${langs.join(", ")}`);
    console.log();
  }

  console.log(pc.dim("Run 'elizaos create' to create a new project."));
  console.log();
}
