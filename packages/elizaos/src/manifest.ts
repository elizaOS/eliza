import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { TemplateDefinition, TemplatesManifest } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedManifest: TemplatesManifest | null = null;

function getPackageRoot(): string {
  return path.resolve(__dirname, "..");
}

export function getTemplatesDir(): string {
  const packageRoot = getPackageRoot();
  const candidates = [
    path.join(packageRoot, "templates"),
    path.join(packageRoot, "..", "templates"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Could not find templates directory");
}

export function loadManifest(): TemplatesManifest {
  if (cachedManifest) {
    return cachedManifest;
  }

  const packageRoot = getPackageRoot();
  const candidates = [
    path.join(packageRoot, "templates-manifest.json"),
    path.join(packageRoot, "..", "templates-manifest.json"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      cachedManifest = JSON.parse(
        fs.readFileSync(candidate, "utf-8"),
      ) as TemplatesManifest;
      return cachedManifest;
    }
  }

  throw new Error(
    "Could not find templates-manifest.json. Please run 'bun run build' first.",
  );
}

export function getTemplates(): TemplateDefinition[] {
  return loadManifest().templates;
}

export function getTemplateById(id: string): TemplateDefinition | undefined {
  return loadManifest().templates.find((template) => template.id === id);
}
