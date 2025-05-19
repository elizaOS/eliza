import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Octokit } from 'octokit';
import semver from 'semver';

/*───────────────────────────────────────────────────────────────────────────*/
// Types
/*───────────────────────────────────────────────────────────────────────────*/

import { RawRegistry, VersionInfo } from '../types/plugins';

/*───────────────────────────────────────────────────────────────────────────*/
// Constants & helpers
/*───────────────────────────────────────────────────────────────────────────*/

const REGISTRY_URL = 'https://github.com/elizaos-plugins/registry/raw/main/index.json';
const GH_TOKEN = process.env.GITHUB_TOKEN;
const octokit = new Octokit({ auth: GH_TOKEN || undefined });
const hasAuth = Boolean(GH_TOKEN);

async function safeFetchJSON<T = unknown>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as T;
    const filtered = Object.entries(data).filter(([key]) => Boolean(key));
    return Object.fromEntries(filtered) as T;
  } catch {
    return null;
  }
}

function parseGitRef(gitRef: string): { owner: string; repo: string } | null {
  if (!gitRef.startsWith('github:')) return null;
  const repoPath = gitRef.slice('github:'.length);
  const [owner, repo] = repoPath.split('/');
  if (!owner || !repo) return null;
  return { owner, repo };
}

async function getGitHubBranches(owner: string, repo: string) {
  try {
    const { data } = await octokit.rest.repos.listBranches({ owner, repo });
    return data.map((b) => b.name);
  } catch {
    return [] as string[];
  }
}

async function fetchPackageJSON(
  owner: string,
  repo: string,
  ref: string
): Promise<{ version: string; coreRange?: string } | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: 'package.json',
      ref,
    });
    if (!('content' in data)) return null;
    const pkg = JSON.parse(Buffer.from(data.content, 'base64').toString());
    const coreRange =
      pkg.dependencies?.['@elizaos/core'] || pkg.peerDependencies?.['@elizaos/core'] || undefined;
    return { version: pkg.version, coreRange };
  } catch {
    return null;
  }
}

async function getLatestGitTags(owner: string, repo: string) {
  try {
    const { data } = await octokit.rest.repos.listTags({ owner, repo, per_page: 100 });
    const versions = data.map((t) => semver.clean(t.name)).filter(Boolean) as string[];
    const sorted = versions.sort(semver.rcompare);
    const latestV0 = sorted.find((v) => semver.major(v) === 0);
    const latestV1 = sorted.find((v) => semver.major(v) === 1);
    return {
      v0: latestV0 || null,
      v1: latestV1 || null,
    };
  } catch (error) {
    console.warn(`⚠️  Failed to fetch tags for ${owner}/${repo}:`, error.message);
    return {
      v0: null,
      v1: null,
    };
  }
}

async function inspectNpm(pkgName: string): Promise<VersionInfo['npm']> {
  const meta = await safeFetchJSON<any>(`https://registry.npmjs.org/${pkgName}`);
  if (!meta) return { exists: false } as any;
  const versions = Object.keys(meta.versions || {});
  const sorted = versions.sort(semver.rcompare);
  const v0 = sorted.find((v) => semver.major(v) === 0);
  const v1 = sorted.find((v) => semver.major(v) === 1);
  return {
    exists: true,
    v0,
    v1,
  };
}

function guessNpmName(jsName: string): string {
  return jsName.replace(/^@elizaos-plugins\//, '@elizaos/');
}

/*───────────────────────────────────────────────────────────────────────────*/
// Core per-repo inspector (fully concurrent within a plugin)
/*───────────────────────────────────────────────────────────────────────────*/

async function processRepo(npmId: string, gitRef: string): Promise<[string, VersionInfo]> {
  const parsed = parseGitRef(gitRef);
  if (!parsed) {
    console.warn(`⚠️  Skipping ${npmId}: unsupported git ref → ${gitRef}`);
    return [
      npmId,
      {
        supports: { v0: false, v1: false },
        npm: { exists: false },
      } as VersionInfo,
    ];
  }
  const { owner, repo } = parsed;

  // Kick off remote calls ---------------------------------------------------
  const branchesPromise = getGitHubBranches(owner, repo);
  const tagsPromise = getLatestGitTags(owner, repo);
  const npmPromise = inspectNpm(guessNpmName(npmId));

  // Support detection via package.json across relevant branches -------------
  const branches = await branchesPromise;
  const branchCandidates = ['main', 'master', '0.x', '1.x'].filter((b) => branches.includes(b));

  const pkgPromises = branchCandidates.map((br) => fetchPackageJSON(owner, repo, br));
  const pkgResults = await Promise.allSettled(pkgPromises);

  const pkgs = [];
  const supportedBranches = {
    v0: null as string | null,
    v1: null as string | null,
  };

  for (let i = 0; i < pkgResults.length; i++) {
    const result = pkgResults[i];
    if (result.status === 'fulfilled' && result.value) {
      const pkg = result.value;
      pkgs.push(pkg);
      const branch = branchCandidates[i];

      let coreRange = pkg?.coreRange;
      if (coreRange?.startsWith('workspace:')) {
        coreRange = coreRange.substring('workspace:'.length);
        if (['*', '^', '~'].includes(coreRange)) {
          coreRange = '>=0.0.0';
        }
      }

      if (coreRange && coreRange !== 'latest') {
        try {
          const major = semver.minVersion(coreRange)?.major;
          if (major === 0) supportedBranches.v0 = branch;
          if (major === 1) supportedBranches.v1 = branch;
        } catch (e) {
          console.warn(`Invalid version range for ${npmId} (${branch}): ${coreRange}`);
        }
      }
    }
  }

  let supportsV0 = false;
  let supportsV1 = false;

  for (const pkg of pkgs) {
    let coreRange = pkg?.coreRange;
    if (coreRange?.startsWith('workspace:')) {
      coreRange = coreRange.substring('workspace:'.length);
      if (['*', '^', '~'].includes(coreRange)) {
        coreRange = '>=0.0.0';
      }
    }
    let major;
    if (coreRange && coreRange !== 'latest') {
      try {
        major = semver.minVersion(coreRange)?.major;
      } catch (e) {
        console.warn(`Invalid version range for ${npmId}: ${coreRange}`);
      }
    }
    if (major === 0) supportsV0 = true;
    if (major === 1) supportsV1 = true;
  }

  const [gitTagInfo, npmInfo] = await Promise.all([tagsPromise, npmPromise]);

  // Set version support based on npm versions
  if (npmInfo?.v0) {
    supportsV0 = true;
  }
  if (npmInfo?.v1) {
    supportsV1 = true;
  }

  console.log(`${npmId} → v0:${supportsV0} v1:${supportsV1}`);

  // Prepare git info with versions and branches
  const gitInfo = {
    v0: {
      version: gitTagInfo?.v0 || npmInfo?.v0 || null,
      branch: supportedBranches.v0,
    },
    v1: {
      version: gitTagInfo?.v1 || npmInfo?.v1 || null,
      branch: supportedBranches.v1,
    },
  };

  // Set version support flags based on both branch detection and npm versions
  supportsV0 = supportsV0 || !!supportedBranches.v0;
  supportsV1 = supportsV1 || !!supportedBranches.v1;

  return [
    npmId,
    {
      git: gitInfo,
      npm: npmInfo,
      supports: { v0: supportsV0, v1: supportsV1 },
    },
  ];
}

/*───────────────────────────────────────────────────────────────────────────*/
// Main
/*───────────────────────────────────────────────────────────────────────────*/

(async () => {
  const registry = (await safeFetchJSON<RawRegistry>(REGISTRY_URL)) || {};
  const report: Record<string, VersionInfo> = {};

  const tasks = Object.entries(registry).map(([npmId, gitRef]) => processRepo(npmId, gitRef));

  if (hasAuth) {
    const results = await Promise.all(tasks);
    for (const [id, info] of results) report[id] = info;
  } else {
    for (const task of tasks) {
      const [id, info] = await task;
      report[id] = info;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /*───────────────────────────────────────────────────────────────────────*/
  // Cache to ~/.eliza/cached-registry.json
  /*───────────────────────────────────────────────────────────────────────*/

  const cacheDir = join(homedir(), '.eliza');
  const cacheFilePath = join(cacheDir, 'cached-registry.json');

  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch (error: any) {
    if (error.code !== 'EEXIST') {
      console.error(`Failed to create cache directory at ${cacheDir}:`, error);
      throw error;
    }
  }

  const dataToSave = {
    lastUpdatedAt: new Date().toISOString(),
    registry: report,
  };

  writeFileSync(cacheFilePath, JSON.stringify(dataToSave, null, 2));
  console.log(`\nDone → ${cacheFilePath}`);
})();
