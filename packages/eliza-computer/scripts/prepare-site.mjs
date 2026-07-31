/**
 * Builds the public contribution-skill artifacts from their canonical source.
 * The site never carries a hand-maintained skill copy: every raw endpoint,
 * archive, checksum, and manifest is regenerated before development or build.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const archiveName = "contribute-to-eliza.skill";
const archivePath = join(downloadsRoot, archiveName);
const sourcePath = "packages/skills/skills/contribute-to-eliza/SKILL.md";
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

mkdirSync(publicRoot, { recursive: true });
mkdirSync(downloadsRoot, { recursive: true });

const skillMarkdown = readFileSync(skillSource);
const repositoryContract = readFileSync(repositoryContractPath, "utf8");
const evidenceRubric = readFileSync(evidenceRubricPath, "utf8");
const skillDigest = sha256(skillMarkdown);
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
if (!/^[0-9a-f]{40}$/.test(commit)) {
  throw new TypeError("[ElizaComputer] git did not return a full commit SHA");
}
const sourceStatus = execFileSync(
  "git",
  [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    "packages/skills/skills/contribute-to-eliza",
  ],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
  },
).trim();
const sourceRevisionStatus =
  sourceStatus.length === 0 ? "committed" : "working-tree";

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
  cpSync(skillRoot, stagedSkillRoot, { recursive: true });
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
      },
      null,
      2,
    )}\n`,
  );
  run("python3", [packager, stagedSkillRoot, stagedDownloadsRoot]);
  const packagedArchive = join(stagedDownloadsRoot, archiveName);
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

Install the checksum-verified complete skill archive into its own directory.
This does not replace a repository's \`AGENTS.md\` or any local instructions.

\`\`\`bash
(
  set -eu
  SKILLS_ROOT="\${CODEX_HOME:-\${HOME}/.codex}/skills"
  TARGET="$SKILLS_ROOT/contribute-to-eliza"
  if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
    printf '%s\n' "Refusing to overwrite existing skill: $TARGET" >&2
    exit 1
  fi
  INSTALL_TMP="$(mktemp -d)"
  TARGET_CREATED=0
  cleanup() {
    rm -rf "$INSTALL_TMP"
    if [ "$TARGET_CREATED" -eq 1 ]; then rm -rf "$TARGET"; fi
  }
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM
  ARCHIVE="$INSTALL_TMP/contribute-to-eliza.skill"
  CHECKSUM="$INSTALL_TMP/contribute-to-eliza.skill.sha256"
  EXTRACTED="$INSTALL_TMP/extracted"
  curl -fsSL --max-filesize 10485760 ${publicSiteOrigin}/downloads/contribute-to-eliza.skill -o "$ARCHIVE"
  curl -fsSL --max-filesize 4096 ${publicSiteOrigin}/downloads/contribute-to-eliza.skill.sha256 -o "$CHECKSUM"
  EXPECTED="$(awk 'NF == 2 && $2 == "contribute-to-eliza.skill" { hash=$1; count++ } END { if (count != 1) exit 1; print hash }' "$CHECKSUM")"
  test "\${#EXPECTED}" -eq 64
  case "$EXPECTED" in ""|*[!0-9A-Fa-f]*) exit 1 ;; esac
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "$ARCHIVE" | awk '{ print $1 }')"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "$ARCHIVE" | awk '{ print $1 }')"
  else
    exit 1
  fi
  test "$ACTUAL" = "$EXPECTED"
  unzip -tq "$ARCHIVE" >/dev/null
  ARCHIVE_ENTRIES="$(unzip -Z1 "$ARCHIVE")"
  test -n "$ARCHIVE_ENTRIES"
  printf '%s\n' "$ARCHIVE_ENTRIES" | awk '
    index($0, "contribute-to-eliza/") != 1 { exit 1 }
    index("/" $0 "/", "/../") { exit 1 }
    index("/" $0 "/", "/./") { exit 1 }
    index($0, "//") { exit 1 }
    index($0, "\\\\") { exit 1 }
    index($0, sprintf("%c", 13)) { exit 1 }
    NR > 128 { exit 1 }
    END { if (NR == 0) exit 1 }
  '
  mkdir "$EXTRACTED"
  unzip -oq "$ARCHIVE" -d "$EXTRACTED"
  if find "$EXTRACTED" ! -type f ! -type d -print -quit | grep -q .; then
    exit 1
  fi
  test -f "$EXTRACTED/contribute-to-eliza/SKILL.md"
  test -f "$EXTRACTED/contribute-to-eliza/PROVENANCE.json"
  mkdir -p "$SKILLS_ROOT"
  if ! mkdir "$TARGET"; then
    printf '%s\n' "Unable to reserve a new skill directory: $TARGET" >&2
    exit 1
  fi
  TARGET_CREATED=1
  cp -R "$EXTRACTED/contribute-to-eliza/." "$TARGET/"
  test -f "$TARGET/SKILL.md"
  test -f "$TARGET/PROVENANCE.json"
  TARGET_CREATED=0
)
\`\`\`

Then ask Codex:

\`\`\`text
Use $contribute-to-eliza to finish one scoped elizaOS issue or independently
review one open elizaOS pull request.
\`\`\`

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
