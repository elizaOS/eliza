import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectTemplateMetadata } from "./types.js";

const METADATA_DIR = ".elizaos";
const METADATA_FILE = "template.json";

export function getMetadataPath(projectRoot: string): string {
  return path.join(projectRoot, METADATA_DIR, METADATA_FILE);
}

export function readProjectMetadata(
  projectRoot: string,
): ProjectTemplateMetadata | null {
  const metadataPath = getMetadataPath(projectRoot);
  if (!fs.existsSync(metadataPath)) {
    return null;
  }

  return JSON.parse(
    fs.readFileSync(metadataPath, "utf-8"),
  ) as ProjectTemplateMetadata;
}

export function writeProjectMetadata(
  projectRoot: string,
  metadata: ProjectTemplateMetadata,
): void {
  const metadataPath = getMetadataPath(projectRoot);
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}
