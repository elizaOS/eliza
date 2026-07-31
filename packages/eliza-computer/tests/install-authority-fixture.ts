/**
 * Builds deterministic file-backed GitHub API and raw-content authorities for
 * installer tests. The fixture mirrors only endpoints the production command
 * is permitted to query, so tests cannot silently fall back to the network.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const REPOSITORY = "elizaOS/eliza";
const SKILL_PATH = "packages/skills/skills/contribute-to-eliza";

export interface AuthorityRevision {
  files: Record<string, Buffer | string>;
  pulls?: unknown[];
}

export interface AuthorityFixtureOptions {
  comparisons?: Record<string, unknown>;
  developHead: string;
  revisions: Record<string, AuthorityRevision>;
  responseOverrides?: Record<string, unknown>;
  timelines?: Record<number, unknown[]>;
}

interface ContentsEntry {
  name: string;
  path: string;
  sha?: string;
  size: number;
  submodule_git_url?: null;
  type: "dir" | "file";
}

function gitBlobSha(contents: Buffer): string {
  return createHash("sha1")
    .update(`blob ${contents.length}\0`)
    .update(contents)
    .digest("hex");
}

function normalizedFiles(
  files: Record<string, Buffer | string>,
): Record<string, Buffer> {
  return Object.fromEntries(
    Object.entries(files).map(([path, contents]) => [
      path,
      Buffer.isBuffer(contents) ? contents : Buffer.from(contents),
    ]),
  );
}

function contentsResponses(
  revision: string,
  files: Record<string, Buffer>,
): Record<string, unknown> {
  const directories = new Map<string, Map<string, ContentsEntry>>();
  directories.set("", new Map());
  for (const [relativePath, contents] of Object.entries(files)) {
    const parts = relativePath.split("/");
    for (let index = 0; index < parts.length - 1; index += 1) {
      const parent = parts.slice(0, index).join("/");
      const child = parts.slice(0, index + 1).join("/");
      const childName = parts[index];
      const entries = directories.get(parent);
      if (!entries) throw new TypeError(`fixture omitted directory ${parent}`);
      entries.set(childName, {
        name: childName,
        path: `${SKILL_PATH}/${child}`,
        size: 0,
        type: "dir",
      });
      if (!directories.has(child)) directories.set(child, new Map());
    }
    const parent = parts.slice(0, -1).join("/");
    const name = parts.at(-1);
    if (!name) throw new TypeError("fixture file path is empty");
    const entries = directories.get(parent);
    if (!entries) throw new TypeError(`fixture omitted directory ${parent}`);
    entries.set(name, {
      name,
      path: `${SKILL_PATH}/${relativePath}`,
      sha: gitBlobSha(contents),
      size: contents.length,
      submodule_git_url: null,
      type: "file",
    });
  }

  return Object.fromEntries(
    [...directories.entries()].map(([relativeDirectory, entries]) => {
      const directory = relativeDirectory
        ? `${SKILL_PATH}/${relativeDirectory}`
        : SKILL_PATH;
      return [
        `/repos/${REPOSITORY}/contents/${directory}?ref=${revision}`,
        [...entries.values()].sort((left, right) =>
          left.name.localeCompare(right.name),
        ),
      ];
    }),
  );
}

export function createInstallAuthorityFixture(
  root: string,
  options: AuthorityFixtureOptions,
): { apiOrigin: string; rawOrigin: string } {
  const apiRoot = join(root, "api");
  const rawRoot = join(root, "raw");
  mkdirSync(apiRoot, { recursive: true });
  mkdirSync(rawRoot, { recursive: true });

  const responses: Record<string, unknown> = {
    [`/repos/${REPOSITORY}/git/ref/heads/develop`]: {
      object: { sha: options.developHead, type: "commit" },
      ref: "refs/heads/develop",
    },
  };
  for (const [revision, configuration] of Object.entries(options.revisions)) {
    const files = normalizedFiles(configuration.files);
    Object.assign(responses, contentsResponses(revision, files));
    responses[
      `/repos/${REPOSITORY}/commits/${revision}/pulls?page=1&per_page=100`
    ] = configuration.pulls ?? [];
    for (const [relativePath, contents] of Object.entries(files)) {
      const destination = join(
        rawRoot,
        ...REPOSITORY.split("/"),
        revision,
        SKILL_PATH,
        ...relativePath.split("/"),
      );
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, contents);
    }
  }
  for (const [comparison, response] of Object.entries(
    options.comparisons ?? {},
  )) {
    responses[`/repos/${REPOSITORY}/compare/${comparison}`] = response;
  }
  for (const [number, timeline] of Object.entries(options.timelines ?? {})) {
    responses[
      `/repos/${REPOSITORY}/issues/${number}/timeline?page=1&per_page=100`
    ] = timeline;
  }
  Object.assign(responses, options.responseOverrides);
  writeFileSync(
    join(apiRoot, "responses.json"),
    `${JSON.stringify(responses, null, 2)}\n`,
  );
  return {
    apiOrigin: pathToFileURL(apiRoot).href.replace(/\/$/u, ""),
    rawOrigin: pathToFileURL(rawRoot).href.replace(/\/$/u, ""),
  };
}

export function aheadComparison(oldRevision: string, newRevision: string) {
  return {
    ahead_by: 1,
    base_commit: { sha: oldRevision },
    behind_by: 0,
    merge_base_commit: { sha: oldRevision },
    status: "ahead",
    total_commits: 1,
    commits: [{ sha: newRevision }],
  };
}
