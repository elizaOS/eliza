/**
 * Builds the public contribution-skill artifacts from their canonical source.
 * The site never carries a hand-maintained skill copy: every raw endpoint,
 * archive, checksum, and manifest is regenerated before development or build.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInstallCommand } from "../src/lib/install-command.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "..", "..");
const publicRoot = join(packageRoot, "public");
const downloadsRoot = join(publicRoot, "downloads");
const skillRoot = join(
  repositoryRoot,
  "packages",
  "skills",
  "skills",
  "contribute-to-eliza",
);
const skillSource = join(skillRoot, "SKILL.md");
const repositoryContractPath = join(
  skillRoot,
  "references",
  "repository-contract.md",
);
const evidenceRubricPath = join(
  skillRoot,
  "references",
  "evidence-review-rubric.md",
);
const packager = join(
  repositoryRoot,
  "packages",
  "skills",
  "skills",
  "skill-creator",
  "scripts",
  "package_skill.py",
);
const archiveNormalizer = join(
  packageRoot,
  "scripts",
  "normalize-skill-archive.py",
);
const archiveName = "contribute-to-eliza.skill";
const archivePath = join(downloadsRoot, archiveName);
const skillRepositoryPath = "packages/skills/skills/contribute-to-eliza";
const sourcePath = `${skillRepositoryPath}/SKILL.md`;
const publicSiteOrigin = "https://eliza.army";

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function run(executable, args, cwd = repositoryRoot) {
  execFileSync(executable, args, {
    cwd,
    stdio: "inherit",
  });
}

function listRegularSkillFiles(root, prefix = "") {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(root, entry.name);
    const relativePath = join(prefix, entry.name).replaceAll("\\", "/");
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink()) {
      throw new TypeError(
        `[ElizaComputer] skill source contains a symlink: ${relativePath}`,
      );
    }
    if (stats.isDirectory()) {
      return listRegularSkillFiles(absolutePath, relativePath);
    }
    if (!stats.isFile()) {
      throw new TypeError(
        `[ElizaComputer] skill source contains a non-regular file: ${relativePath}`,
      );
    }
    return [relativePath];
  });
}

mkdirSync(publicRoot, { recursive: true });
mkdirSync(downloadsRoot, { recursive: true });

const skillMarkdown = readFileSync(skillSource);
const repositoryContract = readFileSync(repositoryContractPath, "utf8");
const evidenceRubric = readFileSync(evidenceRubricPath, "utf8");
const skillDigest = sha256(skillMarkdown);
const trackedSkillFiles = execFileSync(
  "git",
  ["ls-files", "-z", "--", skillRepositoryPath],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
  },
)
  .split("\0")
  .filter(Boolean)
  .map((path) => relative(skillRepositoryPath, path).replaceAll("\\", "/"))
  .sort();
const actualSkillFiles = listRegularSkillFiles(skillRoot).sort();
if (
  trackedSkillFiles.length === 0 ||
  trackedSkillFiles.includes("PROVENANCE.json") ||
  trackedSkillFiles.some(
    (path) => path === ".." || path.startsWith("../") || path.includes("/../"),
  )
) {
  throw new TypeError(
    "[ElizaComputer] tracked skill file manifest is empty, escaped its root, or reserves PROVENANCE.json",
  );
}
if (trackedSkillFiles.length > 32) {
  throw new TypeError(
    "[ElizaComputer] canonical skill exceeds the installer's 32-file authority bound",
  );
}
if (
  trackedSkillFiles.length !== actualSkillFiles.length ||
  trackedSkillFiles.some((path, index) => path !== actualSkillFiles[index])
) {
  const tracked = new Set(trackedSkillFiles);
  const actual = new Set(actualSkillFiles);
  const extras = actualSkillFiles.filter((path) => !tracked.has(path));
  const missing = trackedSkillFiles.filter((path) => !actual.has(path));
  throw new TypeError(
    `[ElizaComputer] skill source must exactly match tracked files (extra: ${extras.join(", ") || "none"}; missing: ${missing.join(", ") || "none"})`,
  );
}
const skillFileManifest = trackedSkillFiles.map((path) => ({
  path,
  sha256: sha256(readFileSync(join(skillRoot, path))),
}));
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
if (!/^[0-9a-f]{40}$/.test(commit)) {
  throw new TypeError("[ElizaComputer] git did not return a full commit SHA");
}
const committedSkillFiles = execFileSync(
  "git",
  ["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", skillRepositoryPath],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
  },
)
  .split("\0")
  .filter(Boolean)
  .map((path) => relative(skillRepositoryPath, path).replaceAll("\\", "/"))
  .sort();
const sourceMatchesCommit =
  committedSkillFiles.length === trackedSkillFiles.length &&
  committedSkillFiles.every(
    (path, index) =>
      path === trackedSkillFiles[index] &&
      readFileSync(join(skillRoot, path)).equals(
        execFileSync("git", ["show", `HEAD:${skillRepositoryPath}/${path}`], {
          cwd: repositoryRoot,
          encoding: null,
          maxBuffer: 16 * 1024 * 1024,
        }),
      ),
  );
const sourceRevisionStatus = sourceMatchesCommit ? "committed" : "working-tree";

run(process.execPath, [
  join(repositoryRoot, "packages", "shared", "scripts", "sync-to-public.mjs"),
  publicRoot,
  "--logos",
  "--favicons",
  "--ogembeds",
]);

const packagingRoot = mkdtempSync(
  join(tmpdir(), "eliza-computer-skill-package-"),
);
const stagedSkillRoot = join(packagingRoot, "contribute-to-eliza");
const stagedDownloadsRoot = join(packagingRoot, "downloads");
const stagedPublicArchive = join(
  downloadsRoot,
  `.${archiveName}.${process.pid}.tmp`,
);
let archive;
try {
  for (const path of trackedSkillFiles) {
    const destination = join(stagedSkillRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(skillRoot, path), destination);
  }
  writeFileSync(
    join(stagedSkillRoot, "PROVENANCE.json"),
    `${JSON.stringify(
      {
        schemaVersion: "1",
        name: "contribute-to-eliza",
        repository: "elizaOS/eliza",
        revision: sourceRevisionStatus === "committed" ? commit : null,
        revisionStatus: sourceRevisionStatus,
        source: {
          path: sourcePath,
          sha256: skillDigest,
        },
        files: skillFileManifest,
      },
      null,
      2,
    )}\n`,
  );
  run("python3", [packager, stagedSkillRoot, stagedDownloadsRoot]);
  const packagedArchive = join(stagedDownloadsRoot, archiveName);
  run("python3", [archiveNormalizer, packagedArchive]);
  archive = readFileSync(packagedArchive);
  if (archive.length === 0) {
    throw new Error("[ElizaComputer] packaged skill archive is empty");
  }
  copyFileSync(packagedArchive, stagedPublicArchive);
  renameSync(stagedPublicArchive, archivePath);
} finally {
  rmSync(stagedPublicArchive, { force: true });
  rmSync(packagingRoot, { force: true, recursive: true });
}

const archiveDigest = sha256(archive);

copyFileSync(skillSource, join(publicRoot, "skill.md"));
const standaloneMission = `${skillMarkdown.toString()}

---

# Embedded repository contract

The URL-only mission embeds both required references so an agent does not need
to fetch or execute additional code. If the local live-report script is absent,
use the read-only inspection commands below and verify live claim state
manually.

${repositoryContract}

---

# Embedded evidence and review rubric

${evidenceRubric}
`;
writeFileSync(join(publicRoot, "mission.md"), standaloneMission);

const codexBootstrap = `# Install contribute-to-eliza for Codex

Install or update the complete skill archive. The installer accepts the current
\`develop\` commit, a develop ancestor only while its complete canonical skill
tree remains byte-identical to current \`develop\`, or a same-repository,
non-draft pull request labeled
\`eliza-army-release-candidate\` after its exact current-head event and fully
synchronized with \`develop\`, then independently compares every packaged byte
with GitHub's immutable source. This does not replace a repository's \`AGENTS.md\`
or any local instructions.

\`\`\`bash
${createInstallCommand(
  publicSiteOrigin,
  `\${CODEX_HOME:-\${HOME}/.codex}/skills`,
)}
\`\`\`

Then ask Codex:

\`\`\`text
Use $contribute-to-eliza to finish one scoped elizaOS issue or independently
review one open elizaOS pull request.
\`\`\`

Versions live beside one atomic \`contribute-to-eliza\` symlink. Re-running the
command is a no-op at the same revision and updates only when GitHub proves the
installed revision is an ancestor of the newly authorized revision. The prior
verified version is retained. To roll back explicitly, export
\`ELIZA_ARMY_SKILL_OPERATION=rollback\` and
\`ELIZA_ARMY_SKILL_REVISION=<retained-40-character-revision>\`, then run the
same command. The rollback revalidates both the active and retained versions
against GitHub before switching the symlink. Unset both variables afterward so
the next invocation returns to install/update mode.

Inspect the installed source before running it:

\`\`\`bash
curl -fsSL ${publicSiteOrigin}/skill-manifest.json
SKILLS_ROOT="\${CODEX_HOME:-\${HOME}/.codex}/skills"
cat "\${SKILLS_ROOT}/contribute-to-eliza/PROVENANCE.json"
sed -n '1,240p' "\${SKILLS_ROOT}/contribute-to-eliza/SKILL.md"
\`\`\`
`;

writeFileSync(join(publicRoot, "codex.md"), codexBootstrap);
writeFileSync(
  join(downloadsRoot, `${archiveName}.sha256`),
  `${archiveDigest}  ${archiveName}\n`,
);

const manifest = {
  schemaVersion: "1",
  name: "contribute-to-eliza",
  repository: "elizaOS/eliza",
  revision: commit,
  revisionStatus: sourceRevisionStatus,
  generatedAt: new Date().toISOString(),
  source: {
    path: sourcePath,
    url: `https://github.com/elizaOS/eliza/blob/${commit}/${sourcePath}`,
    publicUrl: `${publicSiteOrigin}/skill.md`,
    sha256: skillDigest,
  },
  archive: {
    url: `${publicSiteOrigin}/downloads/${archiveName}`,
    sha256: archiveDigest,
    checksumUrl: `${publicSiteOrigin}/downloads/${archiveName}.sha256`,
  },
  authority: {
    apiOrigin: "https://api.github.com",
    rawOrigin: "https://raw.githubusercontent.com",
    canonicalPath: skillRepositoryPath,
    releaseCandidateLabel: "eliza-army-release-candidate",
    acceptedRevisions: [
      "current develop head",
      "develop ancestor whose complete canonical skill tree is byte-identical to current develop",
      "open non-draft same-repository PR head into develop, zero behind current develop, with a release-candidate label event after the exact current-head event",
    ],
  },
  provenance: {
    status: "self-reported",
    policy:
      "Contributors disclose provider, exact model identifier, client, and skill revision. Disclosure is not independently verified and does not affect score.",
  },
};

writeFileSync(
  join(publicRoot, "skill-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(
  `[ElizaComputer] prepared ${archiveName} (${archiveDigest.slice(0, 12)}) from ${commit.slice(0, 12)}`,
);
