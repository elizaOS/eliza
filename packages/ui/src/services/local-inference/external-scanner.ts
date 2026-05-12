/**
 * Discover GGUF files already on disk from other local-inference tools.
 *
 * Users often have LM Studio, Jan, Ollama, or raw HuggingFace downloads
 * lying around. We scan their default cache paths and surface those models
 * in the Model Hub with `source: "external-scan"` so Eliza can load them
 * without re-downloading. Eliza never modifies or deletes these files —
 * the uninstall endpoint refuses when `source !== "eliza-download"`.
 *
 * Ollama is special: its blobs live under `models/blobs/sha256-*` with no
 * `.gguf` extension, and the human name only exists in adjacent manifests.
 * We parse the manifests to recover the mapping; blobs we can't map stay
 * hidden rather than surfacing as opaque hashes.
 */

import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { InstalledModel } from "./types";

type ExternalOrigin = NonNullable<InstalledModel["externalOrigin"]>;

interface ScanRoot {
  origin: ExternalOrigin;
  dir: string;
  /** Extra logic for tools that don't just drop .gguf files by filename. */
  kind: "flat" | "hf-snapshots" | "ollama";
}

function candidateRoots(): ScanRoot[] {
  const home = os.homedir();
  const platform = process.platform;
  const roots: ScanRoot[] = [];

  // ── LM Studio ──────────────────────────────────────────────────────
  roots.push(
    {
      origin: "lm-studio",
      dir: path.join(home, ".lmstudio", "models"),
      kind: "flat",
    },
    {
      origin: "lm-studio",
      dir: path.join(home, ".cache", "lm-studio", "models"),
      kind: "flat",
    },
  );

  // ── Jan ─────────────────────────────────────────────────────────────
  if (platform === "darwin") {
    roots.push({
      origin: "jan",
      dir: path.join(
        home,
        "Library",
        "Application Support",
        "Jan",
        "data",
        "models",
      ),
      kind: "flat",
    });
  } else if (platform === "win32") {
    const appdata =
      process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    roots.push({
      origin: "jan",
      dir: path.join(appdata, "Jan", "data", "models"),
      kind: "flat",
    });
  } else {
    const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
    roots.push({
      origin: "jan",
      dir: path.join(xdg, "Jan", "data", "models"),
      kind: "flat",
    });
  }
  // Legacy Jan path, still seen on older installs.
  roots.push({
    origin: "jan",
    dir: path.join(home, "jan", "models"),
    kind: "flat",
  });

  // ── Ollama ──────────────────────────────────────────────────────────
  const ollamaOverride = process.env.OLLAMA_MODELS?.trim();
  if (ollamaOverride) {
    roots.push({ origin: "ollama", dir: ollamaOverride, kind: "ollama" });
  }
  roots.push({
    origin: "ollama",
    dir: path.join(home, ".ollama", "models"),
    kind: "ollama",
  });
  if (platform === "linux") {
    roots.push(
      {
        origin: "ollama",
        dir: "/usr/share/ollama/.ollama/models",
        kind: "ollama",
      },
      {
        origin: "ollama",
        dir: "/var/lib/ollama/.ollama/models",
        kind: "ollama",
      },
    );
  }

  // ── HuggingFace hub ────────────────────────────────────────────────
  const hfOverride =
    process.env.HF_HUB_CACHE?.trim() ||
    (process.env.HF_HOME ? path.join(process.env.HF_HOME, "hub") : null);
  const hfDefault = path.join(home, ".cache", "huggingface", "hub");
  roots.push({
    origin: "huggingface",
    dir: hfOverride || hfDefault,
    kind: "hf-snapshots",
  });

  // ── text-generation-webui ──────────────────────────────────────────
  // Best-effort common install locations; users can symlink anything they
  // want under here. We only pick up `.gguf` files.
  roots.push(
    {
      origin: "text-gen-webui",
      dir: path.join(home, "text-generation-webui", "user_data", "models"),
      kind: "flat",
    },
    {
      origin: "text-gen-webui",
      dir: path.join(home, "text-generation-webui", "models"),
      kind: "flat",
    },
  );

  return roots;
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function* walkForGgufs(
  root: string,
  maxDepth = 6,
): AsyncGenerator<{
  absPath: string;
  realPath: string;
  size: number;
  mtimeMs: number;
}> {
  const stack: Array<{ dir: string; depth: number }> = [
    { dir: root, depth: 0 },
  ];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    const { dir, depth } = frame;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      // HF snapshots are symlinks into ../blobs/; follow them.
      const isLink = entry.isSymbolicLink();
      if (!isLink && !entry.isFile()) continue;
      if (!full.toLowerCase().endsWith(".gguf")) continue;
      try {
        const realPath = isLink ? await fs.realpath(full) : full;
        const stat = await fs.stat(realPath);
        if (!stat.isFile()) continue;
        yield {
          absPath: full,
          realPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      } catch {
        // Broken symlink or permission issue; skip silently.
      }
    }
  }
}

interface OllamaManifestLayer {
  mediaType: string;
  digest: string;
  size: number;
}

interface OllamaManifest {
  layers: OllamaManifestLayer[];
}

async function scanOllama(root: string): Promise<InstalledModel[]> {
  const manifestsRoot = path.join(root, "manifests");
  const blobsRoot = path.join(root, "blobs");

  if (!(await dirExists(manifestsRoot)) || !(await dirExists(blobsRoot))) {
    return [];
  }

  const results: InstalledModel[] = [];
  const stack: string[] = [manifestsRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let manifest: OllamaManifest;
      try {
        const raw = await fs.readFile(full, "utf8");
        manifest = JSON.parse(raw) as OllamaManifest;
      } catch {
        continue;
      }
      const modelLayer = manifest.layers?.find((l) =>
        l.mediaType?.includes("model"),
      );
      if (!modelLayer?.digest) continue;
      const digest = modelLayer.digest.replace("sha256:", "sha256-");
      const blobPath = path.join(blobsRoot, digest);
      let size = modelLayer.size;
      try {
        const stat = await fs.stat(blobPath);
        size = stat.size;
      } catch {
        continue;
      }
      const relativeManifest = path.relative(manifestsRoot, full);
      const displayName = `ollama: ${relativeManifest.split(path.sep).slice(-2).join(":")}`;
      results.push({
        id: `external-ollama-${digest}`,
        displayName,
        path: blobPath,
        sizeBytes: size,
        installedAt: new Date().toISOString(),
        lastUsedAt: null,
        source: "external-scan",
        externalOrigin: "ollama",
      });
    }
  }
  return results;
}

export async function scanExternalModels(): Promise<InstalledModel[]> {
  const roots = candidateRoots();
  const seenRealPaths = new Set<string>();
  const results: InstalledModel[] = [];

  await Promise.all(
    roots.map(async (root) => {
      if (!(await dirExists(root.dir))) return;

      if (root.kind === "ollama") {
        const ollamaModels = await scanOllama(root.dir);
        for (const model of ollamaModels) {
          if (seenRealPaths.has(model.path)) continue;
          seenRealPaths.add(model.path);
          results.push(model);
        }
        return;
      }

      for await (const found of walkForGgufs(root.dir)) {
        if (seenRealPaths.has(found.realPath)) continue;
        seenRealPaths.add(found.realPath);

        const displayName = path.basename(found.absPath, ".gguf");
        results.push({
          id: `external-${root.origin}-${Buffer.from(found.realPath).toString("base64url").slice(0, 16)}`,
          displayName: `${displayName} (${root.origin})`,
          path: found.realPath,
          sizeBytes: found.size,
          installedAt: new Date(found.mtimeMs).toISOString(),
          lastUsedAt: null,
          source: "external-scan",
          externalOrigin: root.origin,
        });
      }
    }),
  );

  return results;
}
