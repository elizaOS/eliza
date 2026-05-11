#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Octokit } = require("@octokit/rest");
const semver = require("semver");
const dotenv = require("dotenv");
dotenv.config();

// Registry configuration
const REGISTRY_URL =
  "https://raw.githubusercontent.com/elizaos-plugins/registry/refs/heads/next%40registry/index.json";

// Processing configuration
const CONFIG = {
  BATCH_SIZE: parseInt(process.env.BATCH_SIZE) || 10, // Number of repos to process in parallel
  RETRY_ATTEMPTS: parseInt(process.env.RETRY_ATTEMPTS) || 3, // Number of retries for API calls
  BATCH_DELAY_MS: parseInt(process.env.BATCH_DELAY_MS) || 1000, // Delay between batches in milliseconds
};

// Helper function to safely fetch JSON
async function safeFetchJSON(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    return data;
  } catch {
    return null;
  }
}

// Helper function to normalize dependency ranges for semver checks
function normalizeDependencyRange(depRange) {
  if (!depRange || typeof depRange !== 'string') {
    return null;
  }
  
  // Handle common edge cases
  const trimmed = depRange.trim();
  
  // Handle "latest" - treat as very high version that satisfies anything
  if (trimmed === 'latest') {
    return '>=0.0.0';
  }
  
  // Handle exact versions without operators (e.g., "0.25.6-alpha.1", "1.0.0")
  if (semver.valid(semver.clean(trimmed))) {
    // If it's an exact version, convert to ">=" range
    const cleanVersion = semver.clean(trimmed);
    return `>=${cleanVersion}`;
  }
  
  // Handle URL dependencies or invalid ranges
  if (trimmed.startsWith('http') || trimmed.startsWith('git') || trimmed.startsWith('file:')) {
    return null;
  }
  
  // Validate the range and return the normalized value (or null)
  try {
    const valid = semver.validRange(trimmed);
    return valid || null;
  } catch {
    return null;
  }
}

// Check if plugin's core dependency range intersects a major version band
function isCompatibleWithMajorVersion(pluginCoreRange, majorVersion) {
  try {
    const normalizedRange = normalizeDependencyRange(pluginCoreRange);
    if (!normalizedRange) {
      return false;
    }

    // v0 band: >=0.0.0 and <1.0.0  → [0.0.0, 1.0.0)
    // v1 band: >=1.0.0 and <2.0.0  → [1.0.0, 2.0.0)
    // v2 band: >=2.0.0 and <3.0.0  → [2.0.0, 3.0.0)
    let band;
    if (majorVersion === 0) {
      band = ">=0.0.0 <1.0.0";
    } else if (majorVersion === 1) {
      band = ">=1.0.0 <2.0.0";
    } else if (majorVersion === 2) {
      band = ">=2.0.0 <3.0.0";
    } else {
      band = `>=${majorVersion}.0.0 <${majorVersion + 1}.0.0`;
    }
    return semver.intersects(normalizedRange, band, { includePrerelease: true });
  } catch (error) {
    console.warn(`  Failed to check compatibility for major version ${majorVersion} against ${pluginCoreRange}: ${error.message}`);
    return false;
  }
}

// Parse GitHub reference
function parseGitRef(gitRef) {
  if (!gitRef.startsWith("github:")) return null;
  const repoPath = gitRef.slice("github:".length);
  const [owner, repo] = repoPath.split("/");
  if (!owner || !repo) return null;
  return { owner, repo };
}

// Get GitHub branches with retry logic
async function getGitHubBranches(owner, repo, octokit, retries = CONFIG.RETRY_ATTEMPTS) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { data } = await octokit.rest.repos.listBranches({ owner, repo });
      return data.map((b) => b.name);
    } catch (error) {
      if (attempt === retries) {
        console.warn(`  Failed to get branches for ${owner}/${repo} after ${retries} attempts: ${error.message}`);
        return [];
      }
      // Wait before retry (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
    }
  }
  return [];
}

// Get GitHub repository information (including description) with retry logic
async function getGitHubRepoInfo(owner, repo, octokit, retries = CONFIG.RETRY_ATTEMPTS) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { data } = await octokit.rest.repos.get({ owner, repo });
      return {
        description: data.description || null,
        homepage: data.homepage || null,
        topics: data.topics || [],
        stargazers_count: data.stargazers_count || 0,
        language: data.language || null
      };
    } catch (error) {
      if (attempt === retries) {
        console.warn(`  Failed to get repo info for ${owner}/${repo} after ${retries} attempts: ${error.message}`);
        return {
          description: null,
          homepage: null,
          topics: [],
          stargazers_count: 0,
          language: null
        };
      }
      // Wait before retry (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
    }
  }
  return {
    description: null,
    homepage: null,
    topics: [],
    stargazers_count: 0,
    language: null
  };
}

// Fetch a single file from GitHub with retry logic
async function fetchGitHubFile(owner, repo, filePath, ref, octokit, retries = CONFIG.RETRY_ATTEMPTS) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref,
      });
      if (!("content" in data)) return null;
      return JSON.parse(Buffer.from(data.content, "base64").toString());
    } catch (error) {
      if (attempt === retries) {
        // Only warn if this is the primary path (package.json), not fallback paths
        if (filePath === "package.json") {
          console.warn(`  Failed to fetch ${filePath} from ${owner}/${repo}@${ref} after ${retries} attempts: ${error.message}`);
        }
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
    }
  }
  return null;
}

// Extract version info from a package.json object
function extractVersionInfo(pkg) {
  if (!pkg) return null;
  const coreRange =
    pkg.dependencies?.["@elizaos/core"] ||
    pkg.peerDependencies?.["@elizaos/core"] ||
    undefined;
  return { version: pkg.version, coreRange };
}

// Fetch package.json from GitHub, trying multiple paths for v2 monorepo structure
async function fetchPackageJSON(owner, repo, ref, octokit, retries = CONFIG.RETRY_ATTEMPTS) {
  // First try root package.json
  const rootPkg = await fetchGitHubFile(owner, repo, "package.json", ref, octokit, retries);
  if (!rootPkg) return null;

  const rootInfo = extractVersionInfo(rootPkg);
  
  // If the root package has a valid (non-workspace) core range, use it
  if (rootInfo?.coreRange && !rootInfo.coreRange.startsWith("workspace:")) {
    return rootInfo;
  }
  
  // For v2 monorepo structure, try typescript/package.json as it has actual version info
  const tsPkg = await fetchGitHubFile(owner, repo, "typescript/package.json", ref, octokit, 1);
  if (tsPkg) {
    const tsInfo = extractVersionInfo(tsPkg);
    if (tsInfo?.coreRange && !tsInfo.coreRange.startsWith("workspace:")) {
      return tsInfo;
    }
  }
  
  // Fallback to root info even if core range is workspace:*
  return rootInfo;
}

// Find the latest tag for a given major version from sorted tags
function findLatestTagForMajor(sortedTags, majorVersion) {
  const majorTags = sortedTags.filter((tag) => semver.major(semver.clean(tag.name)) === majorVersion);
  if (majorTags.length === 0) return null;
  
  // First, try to find a stable tag
  const stableTag = majorTags.find(tag => !semver.clean(tag.name).includes('-'));
  if (stableTag) return stableTag;
  
  // If no stable version, use the latest pre-release
  return majorTags[0];
}

// Get latest Git tags
async function getLatestGitTags(owner, repo, octokit) {
  try {
    const { data } = await octokit.rest.repos.listTags({
      owner,
      repo,
      per_page: 100,
    });
    
    // Filter tags that have valid semver versions
    const validTags = data.filter(tag => semver.clean(tag.name));
    
    // Sort by cleaned version (for comparison) but keep original tag names
    const sorted = validTags.sort((a, b) => 
      semver.rcompare(semver.clean(a.name), semver.clean(b.name))
    );
    
    // Find latest tag for each major version
    const latestV0Tag = findLatestTagForMajor(sorted, 0);
    const latestV1Tag = findLatestTagForMajor(sorted, 1);
    const latestV2Tag = findLatestTagForMajor(sorted, 2);
    
    return {
      repo: `${owner}/${repo}`,
      v0: latestV0Tag ? latestV0Tag.name : null,
      v1: latestV1Tag ? latestV1Tag.name : null,
      v2: latestV2Tag ? latestV2Tag.name : null,
    };
  } catch (error) {
    console.warn(`Failed to get tags for ${owner}/${repo}:`, error.message);
    return { repo: `${owner}/${repo}`, v0: null, v1: null, v2: null };
  }
}

// Find the latest npm version for a given major version
function findLatestNpmVersionForMajor(sortedVersions, majorVersion) {
  const majorVersions = sortedVersions.filter((v) => semver.major(v) === majorVersion);
  if (majorVersions.length === 0) return null;
  
  // First, try to find a stable version
  const stable = majorVersions.find(v => !v.includes('-'));
  if (stable) return stable;
  
  // If no stable version, use the latest pre-release
  return majorVersions[0];
}

// Get core dependency range from npm version metadata
function getCoreRangeFromNpmVersion(meta, version) {
  if (!version || !meta.versions[version]) return null;
  const pkg = meta.versions[version];
  return pkg.dependencies?.["@elizaos/core"] || 
         pkg.peerDependencies?.["@elizaos/core"] || null;
}

// Inspect NPM package
async function inspectNpm(pkgName) {
  const meta = await safeFetchJSON(`https://registry.npmjs.org/${pkgName}`);
  if (!meta || !meta.versions) {
    return { repo: pkgName, v0: null, v1: null, v2: null, v0CoreRange: null, v1CoreRange: null, v2CoreRange: null };
  }
  const versions = Object.keys(meta.versions);
  const sorted = versions.sort(semver.rcompare);
  
  // Find latest version for each major
  const v0 = findLatestNpmVersionForMajor(sorted, 0);
  const v1 = findLatestNpmVersionForMajor(sorted, 1);
  const v2 = findLatestNpmVersionForMajor(sorted, 2);
  
  // Get core dependency ranges for the found versions
  const v0CoreRange = getCoreRangeFromNpmVersion(meta, v0);
  const v1CoreRange = getCoreRangeFromNpmVersion(meta, v1);
  const v2CoreRange = getCoreRangeFromNpmVersion(meta, v2);
  
  return {
    repo: pkgName,
    v0,
    v1,
    v2,
    v0CoreRange,
    v1CoreRange,
    v2CoreRange,
  };
}

// Guess NPM name from JS name
function guessNpmName(jsName) {
  // Keep @elizaos-plugins/ scope for packages that exist under the new scope
  // For now, fallback to @elizaos/ for compatibility, but this should be updated
  // when packages are fully migrated to @elizaos-plugins/
  return jsName.replace(/^@elizaos-plugins\//, "@elizaos/");
}

// Process a single repository
async function processRepo(npmId, gitRef, octokit) {
  const parsed = parseGitRef(gitRef);
  if (!parsed) {
    throw new Error(`Invalid git reference: ${gitRef}`);
  }
  const { owner, repo } = parsed;

  console.log(`Processing ${npmId} (${owner}/${repo})`);

  // Track issues for summary
  const issues = [];

  // Kick off remote calls
  const branchesPromise = getGitHubBranches(owner, repo, octokit);
  const tagsPromise = getLatestGitTags(owner, repo, octokit);
  const repoInfoPromise = getGitHubRepoInfo(owner, repo, octokit);
  const npmPromise = inspectNpm(guessNpmName(npmId));

  // Support detection via package.json across relevant branches
  const branches = await branchesPromise;
  if (branches.length === 0) {
    issues.push(`No branches found (might be API issue)`);
  }
  const branchCandidates = ["main", "master", "0.x", "1.x", "2.x", "next"].filter((b) =>
    branches.includes(b)
  );
  if (branchCandidates.length === 0 && branches.length > 0) {
    issues.push(`No standard branches found (has: ${branches.slice(0, 3).join(', ')}${branches.length > 3 ? '...' : ''})`);
  }

  const pkgPromises = branchCandidates.map((br) =>
    fetchPackageJSON(owner, repo, br, octokit)
  );
  const pkgResults = await Promise.allSettled(pkgPromises);

  const pkgs = [];
  const supportedBranches = {
    v0: null,
    v1: null,
    v2: null,
  };

  for (let i = 0; i < pkgResults.length; i++) {
    const result = pkgResults[i];
    if (result.status === "fulfilled" && result.value) {
      const branch = branchCandidates[i];
      const pkg = result.value;
      pkgs.push({ ...pkg, branch });
    } else if (result.status === "rejected") {
      console.warn(`  Failed to fetch package.json from ${branchCandidates[i]} branch: ${result.reason?.message || 'Unknown error'}`);
    }
  }

  let supportsV0 = false;
  let supportsV1 = false;
  let supportsV2 = false;

  for (const pkg of pkgs) {
    if (pkg.version && pkg.coreRange) {
      const cleanedVersion = semver.clean(pkg.version);
      if (!cleanedVersion) continue;
      const pkgMajor = semver.major(cleanedVersion);
      const satisfiesV0Core = isCompatibleWithMajorVersion(pkg.coreRange, 0);
      const satisfiesV1Core = isCompatibleWithMajorVersion(pkg.coreRange, 1);
      const satisfiesV2Core = isCompatibleWithMajorVersion(pkg.coreRange, 2);

      // For v0: package version must be < 1.0.0 AND core dependency should be compatible
      if (pkgMajor === 0 && satisfiesV0Core) {
        supportsV0 = true;
        supportedBranches.v0 = pkg.branch;
      }
      
      // For v1: package version must be >= 1.0.0 and < 2.0.0 AND core dependency should be compatible
      if (pkgMajor === 1 && satisfiesV1Core) {
        supportsV1 = true;
        supportedBranches.v1 = pkg.branch;
      }
      
      // For v2: package version must be >= 2.0.0 AND core dependency should be compatible
      if (pkgMajor >= 2 && satisfiesV2Core) {
        supportsV2 = true;
        supportedBranches.v2 = pkg.branch;
      }
    }
  }

  const [gitTagInfo, npmInfo, repoInfo] = await Promise.all([tagsPromise, npmPromise, repoInfoPromise]);

  // Helper to detect if a raw core range is clearly v0, v1, or v2 targeted
  // Only matches definitive constraints: exact versions, ^ (compatible), ~ (patch)
  // Excludes ambiguous operators like >=, >, <, <= that may span multiple majors
  const getCoreRangeMajor = (range) => {
    if (!range || typeof range !== 'string') return null;
    const trimmed = range.trim();
    if (trimmed === 'latest') return null; // ambiguous
    // Check for explicit v0 patterns: "0.x", "^0.x", "~0.x" (but NOT ">=0.x", "<1.x")
    if (/^[\^~]?0\./.test(trimmed)) return 0;
    // Check for explicit v1 patterns: "1.x", "^1.x", "~1.x" (but NOT ">=1.x", "<2.x")
    if (/^[\^~]?1\./.test(trimmed)) return 1;
    // Check for explicit v2 patterns: "2.x", "^2.x", "~2.x" (but NOT ">=2.x", "<3.x")
    if (/^[\^~]?2\./.test(trimmed)) return 2;
    return null;
  };

  // Set version support based on npm versions and core dependencies (more reliable)
  // The core dependency is what determines actual compatibility, not the package version
  const npmVersionChecks = [
    { key: 'v0', expectedMajor: 0 },
    { key: 'v1', expectedMajor: 1 },
    { key: 'v2', expectedMajor: 2 },
  ];

  for (const { key, expectedMajor } of npmVersionChecks) {
    const npmVersion = npmInfo?.[key];
    const npmCoreRange = npmInfo?.[`${key}CoreRange`];
    if (!npmVersion || !npmCoreRange) continue;

    const cleanedVersion = semver.clean(npmVersion);
    if (!cleanedVersion) continue;
    const pkgMajor = semver.major(cleanedVersion);
    const coreTargetMajor = getCoreRangeMajor(npmCoreRange);

    // Check if the package version matches the expected major and core dep is compatible
    if (pkgMajor === expectedMajor && isCompatibleWithMajorVersion(npmCoreRange, expectedMajor)) {
      if (expectedMajor === 0) supportsV0 = true;
      else if (expectedMajor === 1) supportsV1 = true;
      else if (expectedMajor === 2) supportsV2 = true;
    }

    // Detect mismatches: package version says one thing, core dep says another
    if (coreTargetMajor !== null && coreTargetMajor !== expectedMajor) {
      if (coreTargetMajor === 0) supportsV0 = true;
      else if (coreTargetMajor === 1) supportsV1 = true;
      else if (coreTargetMajor === 2) supportsV2 = true;
      issues.push(`⚠️ ${key} package (${npmVersion}) depends on v${coreTargetMajor} core (${npmCoreRange}) - version mismatch`);
    }
  }

  console.log(`${npmId} → v0:${supportsV0} v1:${supportsV1} v2:${supportsV2}`);

  // Prepare git info with versions and branches
  // When GitHub data is not available, use npm data as fallback
  const gitInfo = {
    repo: gitTagInfo?.repo || npmInfo?.repo || `${owner}/${repo}`,
    v0: {
      version: gitTagInfo?.v0 || npmInfo?.v0 || null,
      branch: supportedBranches.v0,
    },
    v1: {
      version: gitTagInfo?.v1 || npmInfo?.v1 || null,
      branch: supportedBranches.v1,
    },
    v2: {
      version: gitTagInfo?.v2 || npmInfo?.v2 || null,
      branch: supportedBranches.v2,
    },
  };

  // Version support flags have already been properly set based on version constraints
  // No need to override them here

  // ── App metadata detection ────────────────────────────────────────────
  // Check if this package declares itself as an app via:
  //   1. elizaos.plugin.json with kind: "app"
  //   2. package.json with elizaos.kind: "app"
  // If found, include the app metadata in the registry entry.
  let appMeta = null;

  // Determine the best branch to check for app metadata (prefer main, then master)
  const appMetaBranch = branchCandidates.find(b => b === "main") ||
    branchCandidates.find(b => b === "master") ||
    branchCandidates[0] || "main";

  // Try fetching elizaos.plugin.json first (the canonical manifest location)
  const pluginManifest = await fetchGitHubFile(owner, repo, "elizaos.plugin.json", appMetaBranch, octokit, 1);
  if (pluginManifest && pluginManifest.kind === "app" && pluginManifest.app) {
    appMeta = {
      displayName: pluginManifest.app.displayName || pluginManifest.name || npmId.replace(/^@elizaos\/app-/, ""),
      category: pluginManifest.app.category || "game",
      launchType: pluginManifest.app.launchType || "url",
      launchUrl: pluginManifest.app.launchUrl || null,
      icon: pluginManifest.app.icon || null,
      capabilities: pluginManifest.app.capabilities || [],
      minPlayers: pluginManifest.app.minPlayers || null,
      maxPlayers: pluginManifest.app.maxPlayers || null,
    };
  }

  // Fallback: check package.json elizaos.kind field
  if (!appMeta) {
    const mainPkg = await fetchGitHubFile(owner, repo, "package.json", appMetaBranch, octokit, 1);
    if (mainPkg && mainPkg.elizaos && mainPkg.elizaos.kind === "app" && mainPkg.elizaos.app) {
      const pkgApp = mainPkg.elizaos.app;
      appMeta = {
        displayName: pkgApp.displayName || mainPkg.name || npmId.replace(/^@elizaos\/app-/, ""),
        category: pkgApp.category || "game",
        launchType: pkgApp.launchType || "url",
        launchUrl: pkgApp.launchUrl || null,
        icon: pkgApp.icon || null,
        capabilities: pkgApp.capabilities || [],
        minPlayers: pkgApp.minPlayers || null,
        maxPlayers: pkgApp.maxPlayers || null,
      };
    }
  }

  // Also check for monorepo structures: try typescript/elizaos.plugin.json
  if (!appMeta) {
    const tsManifest = await fetchGitHubFile(owner, repo, "typescript/elizaos.plugin.json", appMetaBranch, octokit, 1);
    if (tsManifest && tsManifest.kind === "app" && tsManifest.app) {
      appMeta = {
        displayName: tsManifest.app.displayName || tsManifest.name || npmId.replace(/^@elizaos\/app-/, ""),
        category: tsManifest.app.category || "game",
        launchType: tsManifest.app.launchType || "url",
        launchUrl: tsManifest.app.launchUrl || null,
        icon: tsManifest.app.icon || null,
        capabilities: tsManifest.app.capabilities || [],
        minPlayers: tsManifest.app.minPlayers || null,
        maxPlayers: tsManifest.app.maxPlayers || null,
      };
    }
  }

  const entry = {
    git: gitInfo,
    npm: npmInfo,
    supports: { v0: supportsV0, v1: supportsV1, v2: supportsV2 },
    description: repoInfo.description,
    homepage: repoInfo.homepage,
    topics: repoInfo.topics,
    stargazers_count: repoInfo.stargazers_count,
    language: repoInfo.language,
  };

  // Attach app metadata when present — consumers use this to distinguish apps from plugins
  if (appMeta) {
    entry.kind = "app";
    entry.app = appMeta;
    console.log(`  ✨ Detected as app: ${appMeta.displayName} (${appMeta.launchType})`);
  }

  return [npmId, entry, issues];
}

// Main function to parse registry
async function parseRegistry(githubToken) {
  const octokit = new Octokit({ auth: githubToken });

  // Read local index.json file instead of fetching from URL
  const indexPath = path.join(__dirname, "..", "index.json");
  let registry;

  try {
    const indexContent = fs.readFileSync(indexPath, "utf8");
    registry = JSON.parse(indexContent);
    console.log(`Read ${Object.keys(registry).length} total entries from index.json`);
  } catch (error) {
    console.error("Failed to read index.json:", error);
    return null;
  }

  // Filter out comment entries (empty keys or keys that are just empty strings)
  const filteredRegistry = {};
  for (const [key, value] of Object.entries(registry)) {
    if (key && key.trim() !== "" && typeof value === "string" && value.startsWith("github:")) {
      filteredRegistry[key] = value;
    } else {
      console.log(`Filtering out entry: "${key}" -> "${value}"`);
    }
  }

  console.log(`Filtered to ${Object.keys(filteredRegistry).length} valid entries`);
  
  const report = {};
  const allIssues = {};
  // Sort entries alphabetically by key before processing
  const entries = Object.entries(filteredRegistry).sort(([a], [b]) => a.localeCompare(b));
  const batchSize = CONFIG.BATCH_SIZE;
  
  console.log(`Processing ${entries.length} repositories in batches of ${batchSize}...`);
  
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const batchNumber = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(entries.length / batchSize);
    
    console.log(`\nProcessing batch ${batchNumber}/${totalBatches} (${batch.length} repos)...`);
    
    const tasks = batch.map(([npmId, gitRef]) =>
      processRepo(npmId, gitRef, octokit)
    );
    
    const results = await Promise.all(tasks);
    
    for (const [id, info, issues] of results) {
      report[id] = info;
      if (issues && issues.length > 0) {
        allIssues[id] = issues;
      }
    }
    
    // Add a small delay between batches to avoid rate limiting
    if (i + batchSize < entries.length) {
      await new Promise(resolve => setTimeout(resolve, CONFIG.BATCH_DELAY_MS));
    }
  }
  
  // Report issues summary
  const issueCount = Object.keys(allIssues).length;
  if (issueCount > 0) {
    console.log(`\n⚠️  Issues encountered for ${issueCount} repositories:`);
    for (const [id, issues] of Object.entries(allIssues)) {
      console.log(`  ${id}:`);
      issues.forEach(issue => console.log(`    - ${issue}`));
    }
  }

  // Sort the final report by keys
  const sortedReport = {};
  Object.keys(report).sort().forEach(key => {
    sortedReport[key] = report[key];
  });

  return {
    lastUpdatedAt: new Date().toISOString(),
    registry: sortedReport,
  };
}

// Main execution
async function main() {
  const githubToken = process.env.GITHUB_TOKEN;

  if (!githubToken) {
    console.error("GITHUB_TOKEN environment variable is required");
    process.exit(1);
  }

  try {
    console.log("Starting registry generation...");
    const result = await parseRegistry(githubToken);

    if (!result) {
      console.error("Failed to generate registry");
      process.exit(1);
    }

    const outputPath = path.join(__dirname, "..", "generated-registry.json");
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));

    console.log(`Registry generated successfully: ${outputPath}`);
    console.log(`Generated ${Object.keys(result.registry).length} entries`);
  } catch (error) {
    console.error("Error generating registry:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
