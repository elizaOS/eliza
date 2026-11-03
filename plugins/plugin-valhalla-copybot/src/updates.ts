import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const DESK_VERSION = "0.2.0";
export const VERSION_URL =
  "https://github.com/TokenJunction/eliza-valhalla/releases/latest/download/version.json";

export const WHATS_NEW = [
  "Self-repair watches hung calls and restarts only when nothing is open.",
  "Valhalla Brain can explain a skip. It cannot place a trade.",
  "The phone can open a demo before any wallet exists.",
];

export const UPDATE_PROMPT = "Update ready, restart";

export interface ReleaseAsset {
  url: string;
  sha256: string;
}

export interface VersionManifest {
  version: string;
  notes?: string;
  windows?: ReleaseAsset;
  android?: ReleaseAsset;
}

export function newerRelease(current: string, tag: string): boolean {
  const parse = (value: string) =>
    value
      .replace(/^v/i, "")
      .split(/[.-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(current);
  const right = parse(tag);
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (b > a) return true;
    if (b < a) return false;
  }
  return false;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hashMatches(actual: string, expected: string): boolean {
  const left = actual.trim().toLowerCase();
  const right = expected.trim().toLowerCase();
  return left.length === 64 && left === right;
}

export async function fetchVersionManifest(
  fetchImpl: typeof fetch = fetch
): Promise<VersionManifest | null> {
  const response = await fetchImpl(VERSION_URL, { headers: { accept: "application/json" } });
  if (!response.ok) return null;
  const body = (await response.json()) as VersionManifest;
  if (!body.version) return null;
  return body;
}

/** Download a release file and keep it only when the SHA-256 matches version.json. */
export async function stageVerifiedDownload(
  asset: ReleaseAsset,
  dest: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const response = await fetchImpl(asset.url);
  if (!response.ok) return false;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!hashMatches(sha256Hex(bytes), asset.sha256)) return false;
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, bytes);
  return true;
}

export async function checkDesktopUpdate(
  current: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ update: boolean; latest: string; notes: string; prompt: string }> {
  const manifest = await fetchVersionManifest(fetchImpl);
  if (!manifest) {
    const response = await fetchImpl(
      "https://api.github.com/repos/TokenJunction/eliza-valhalla/releases/latest",
      { headers: { accept: "application/vnd.github+json" } }
    );
    if (!response.ok) {
      return { update: false, latest: current, notes: WHATS_NEW.join(" "), prompt: UPDATE_PROMPT };
    }
    const body = (await response.json()) as { tag_name?: string; body?: string };
    const latest = body.tag_name ?? current;
    return {
      update: newerRelease(current, latest),
      latest,
      notes: body.body?.slice(0, 400) || WHATS_NEW.join(" "),
      prompt: UPDATE_PROMPT,
    };
  }
  return {
    update: newerRelease(current, manifest.version) && Boolean(manifest.windows?.sha256),
    latest: manifest.version,
    notes: manifest.notes || WHATS_NEW.join(" "),
    prompt: UPDATE_PROMPT,
  };
}
