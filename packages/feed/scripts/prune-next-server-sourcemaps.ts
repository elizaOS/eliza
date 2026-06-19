import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const SOURCE_MAP_COMMENT_PATTERNS = [
  /\n\/\/# sourceMappingURL=.*?(?=\n|$)/g,
  /\n\/\*# sourceMappingURL=.*?\*\/(?=\n|$)/g,
];

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(fullPath);
      return [fullPath];
    }),
  );

  return files.flat();
}

async function main() {
  const nextDirArg = process.argv[2] ?? ".next";
  const nextDir = path.resolve(process.cwd(), nextDirArg);
  const serverDir = path.join(nextDir, "server");

  try {
    await stat(serverDir);
  } catch {
    console.log(
      `[prune-next-server-sourcemaps] skipping: missing server directory at ${serverDir}`,
    );
    return;
  }

  const allFiles = await walk(nextDir);
  const nftFiles = allFiles.filter((file) => file.endsWith(".nft.json"));
  const serverRuntimeFiles = allFiles.filter(
    (file) =>
      file.startsWith(serverDir) &&
      (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")),
  );
  const serverMapFiles = allFiles.filter(
    (file) => file.startsWith(serverDir) && file.endsWith(".map"),
  );

  let removedManifestEntries = 0;
  let strippedSourceMapComments = 0;

  for (const nftFile of nftFiles) {
    const raw = await readFile(nftFile, "utf8");
    const parsed = JSON.parse(raw) as { files?: string[] };

    if (!Array.isArray(parsed.files)) continue;

    const filteredFiles = parsed.files.filter((file) => !file.endsWith(".map"));
    removedManifestEntries += parsed.files.length - filteredFiles.length;

    if (filteredFiles.length !== parsed.files.length) {
      parsed.files = filteredFiles;
      await writeFile(nftFile, `${JSON.stringify(parsed)}\n`, "utf8");
    }
  }

  for (const runtimeFile of serverRuntimeFiles) {
    const raw = await readFile(runtimeFile, "utf8");
    let next = raw;

    for (const pattern of SOURCE_MAP_COMMENT_PATTERNS) {
      next = next.replace(pattern, "");
    }

    if (next !== raw) {
      strippedSourceMapComments += 1;
      await writeFile(runtimeFile, next, "utf8");
    }
  }

  let emptiedMapFiles = 0;
  for (const mapFile of serverMapFiles) {
    await writeFile(mapFile, "", "utf8");
    emptiedMapFiles += 1;
  }

  console.log(
    `[prune-next-server-sourcemaps] updated ${nftFiles.length} nft files, stripped ${strippedSourceMapComments} runtime sourcemap comments, removed ${removedManifestEntries} nft sourcemap references, emptied ${emptiedMapFiles} server sourcemaps`,
  );
}

await main();
