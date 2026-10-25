/**
 * Plans relocation of generation-owned directory links before atomic publication.
 * Windows junctions store absolute targets, so publication and fallback must
 * reuse recorded relative edges rather than inspect temporarily dangling links.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ElizaError } from "@elizaos/core";

export interface StagedDirectoryLink {
  readonly link: string;
  readonly target: string;
}

function inside(child: string, root: string): boolean {
  const relative = path.relative(root, child);
  return (
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

function invalidLink(root: string, link: string): ElizaError {
  return new ElizaError(
    "Staged directory link is outside its owned generation",
    {
      code: "STAGED_DIRECTORY_LINK_INVALID",
      context: { root, link },
    },
  );
}

export async function collectStagedDirectoryLinks(
  root: string,
): Promise<StagedDirectoryLink[]> {
  const canonicalRoot = await fs.realpath(root);
  const links: StagedDirectoryLink[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(candidate);
      if (!entry.isSymbolicLink()) continue;
      const literalTarget = await fs.readlink(candidate);
      if (!path.isAbsolute(literalTarget)) continue;
      const target = await fs.realpath(candidate);
      // Existing hoisted links have a separate external-resolution contract;
      // publication rewrites only aliases owned by this generation.
      if (
        !inside(target, canonicalRoot) ||
        !(await fs.stat(target)).isDirectory()
      )
        continue;
      links.push({
        link: path.relative(canonicalRoot, candidate),
        target: path.relative(canonicalRoot, target),
      });
    }
  };
  await walk(canonicalRoot);
  return links;
}

export async function relocateStagedDirectoryLinks(
  links: readonly StagedDirectoryLink[],
  currentRoot: string,
  publishedRoot: string,
): Promise<void> {
  const canonicalCurrent = await fs.realpath(currentRoot);
  const publishedParent = await fs.realpath(path.dirname(publishedRoot));
  if (publishedParent !== path.dirname(canonicalCurrent))
    throw invalidLink(canonicalCurrent, publishedRoot);
  const canonicalPublished = path.join(
    publishedParent,
    path.basename(publishedRoot),
  );
  const planned: { link: string; target: string }[] = [];
  for (const edge of links) {
    if (path.isAbsolute(edge.link) || path.isAbsolute(edge.target)) {
      throw invalidLink(canonicalCurrent, edge.link);
    }
    const link = path.resolve(canonicalCurrent, edge.link);
    const target = path.resolve(canonicalPublished, edge.target);
    if (
      link === canonicalCurrent ||
      !inside(link, canonicalCurrent) ||
      !inside(target, canonicalPublished)
    )
      throw invalidLink(canonicalCurrent, edge.link);
    const parent = await fs.realpath(path.dirname(link));
    if (
      !inside(parent, canonicalCurrent) ||
      !(await fs.lstat(link)).isSymbolicLink()
    )
      throw invalidLink(canonicalCurrent, edge.link);
    planned.push({ link, target });
  }
  for (const edge of planned) {
    await fs.unlink(edge.link);
    await fs.symlink(
      edge.target,
      edge.link,
      process.platform === "win32" ? "junction" : "dir",
    );
  }
}
