import * as fs from "node:fs";
import * as path from "node:path";
import { getPackageRoot } from "./package-info.js";
import type { TemplateDefinition, TemplatesManifest } from "./types.js";

let cachedManifest: TemplatesManifest | null = null;

export function getTemplatesDir(): string {
  const dir = path.join(getPackageRoot(), "templates");
  if (fs.existsSync(dir)) {
    return dir;
  }

  throw new Error("Could not find templates directory");
}

export function loadManifest(): TemplatesManifest {
  if (cachedManifest) {
    return cachedManifest;
  }

  const packageRoot = getPackageRoot();
  const candidates = [path.join(packageRoot, "templates-manifest.json")];

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
  return loadManifest().templates.find(
    (template) => template.id === id || template.aliases?.includes(id),
  );
}

export const TEMPLATE_ICONS: Record<string, string> = {
  plugin: "🔌",
  project: "🧱",
};
