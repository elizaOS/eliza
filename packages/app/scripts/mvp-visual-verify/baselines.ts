/** Logical visual states reference immutable images so identical captures share bytes. */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface BaselineManifest {
  version: 1;
  states: Record<string, string>;
}

function stateKey(viewport: string, slug: string): string {
  const key = `${viewport}/${slug}`;
  if (!/^[\w-]+\/[\w-]+$/.test(key))
    throw new Error(`Invalid baseline state: ${key}`);
  return key;
}

export async function loadBaselineManifest(
  root: string,
): Promise<BaselineManifest> {
  let text: string;
  try {
    text = await readFile(path.join(root, "manifest.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, states: {} };
    throw error;
  }
  const value = JSON.parse(text);
  if (
    value?.version !== 1 ||
    !value.states ||
    typeof value.states !== "object" ||
    Array.isArray(value.states)
  ) {
    throw new Error("Invalid visual baseline manifest");
  }
  for (const [key, image] of Object.entries(value.states)) {
    const parts = key.split("/");
    if (
      parts.length !== 2 ||
      stateKey(parts[0], parts[1]) !== key ||
      typeof image !== "string" ||
      !/^images\/[a-f0-9]{64}\.png$/.test(image)
    ) {
      throw new Error(`Invalid visual baseline entry: ${key}`);
    }
  }
  return value;
}

export function resolveBaselinePath(
  root: string,
  manifest: BaselineManifest,
  viewport: string,
  slug: string,
): string {
  const key = stateKey(viewport, slug);
  return path.join(root, manifest.states[key] ?? `missing/${key}.png`);
}

export function requiredBaselineStates(
  manifest: BaselineManifest,
  viewports: string[],
): string[] {
  return Object.keys(manifest.states)
    .filter((key) => !viewports.length || viewports.includes(key.split("/")[0]))
    .map((key) => {
      const [viewport, slug] = key.split("/");
      return `${slug}@${viewport}`;
    })
    .sort();
}

/** Updating one logical state never overwrites another state's shared image. */
export async function recordBaseline(
  root: string,
  manifest: BaselineManifest,
  viewport: string,
  slug: string,
  source: string,
): Promise<void> {
  const key = stateKey(viewport, slug);
  const bytes = await readFile(source);
  const image = `images/${createHash("sha256").update(bytes).digest("hex")}.png`;
  await mkdir(path.join(root, "images"), { recursive: true });
  await writeFile(path.join(root, image), bytes);
  manifest.states[key] = image;
}

export async function saveBaselineManifest(
  root: string,
  manifest: BaselineManifest,
): Promise<void> {
  const filename = path.join(root, "manifest.json");
  const temporary = `${filename}.${process.pid}.tmp`;
  await mkdir(root, { recursive: true });
  const sorted = {
    version: 1,
    states: Object.fromEntries(
      Object.entries(manifest.states).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  await writeFile(temporary, `${JSON.stringify(sorted, null, 2)}\n`);
  await rename(temporary, filename);
}
