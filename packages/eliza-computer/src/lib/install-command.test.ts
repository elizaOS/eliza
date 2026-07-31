/**
 * Exercises installer authorization and lifecycle transitions against a
 * deterministic file-backed GitHub authority and real generated ZIP archives.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AuthorityFixtureOptions,
  aheadComparison,
  createInstallAuthorityFixture,
} from "../../tests/install-authority-fixture";
import { createInstallCommand } from "./install-command";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const repositoryRoot = resolve(packageRoot, "..", "..");
const normalizeArchive = join(
  packageRoot,
  "scripts",
  "normalize-skill-archive.py",
);
const revisionA = "a".repeat(40);
const revisionB = "b".repeat(40);
const revisionC = "c".repeat(40);
const revisionD = "d".repeat(40);
const roots: string[] = [];

interface ArtifactOptions {
  archiveFiles?: Record<string, Buffer | string>;
  provenanceRevision?: string | null;
  revisionStatus?: "committed" | "working-tree";
}

function sha256(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function freshRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `eliza-installer-${label}-`));
  roots.push(root);
  return root;
}

function baseFiles(marker: string): Record<string, Buffer> {
  const skill = execFileSync(
    "git",
    ["show", "HEAD:packages/skills/skills/contribute-to-eliza/SKILL.md"],
    { cwd: repositoryRoot, encoding: null },
  );
  return {
    "SKILL.md": skill,
    "references/revision.txt": Buffer.from(`${marker}\n`),
  };
}

function writeArtifact(
  root: string,
  revision: string,
  canonicalFiles: Record<string, Buffer | string>,
  options: ArtifactOptions = {},
): string {
  const publicRoot = join(root, `artifact-${revision.slice(0, 4)}`);
  const archivePath = join(
    publicRoot,
    "downloads",
    "contribute-to-eliza.skill",
  );
  const stagedRoot = join(root, `stage-${revision.slice(0, 4)}`);
  const stagedSkill = join(stagedRoot, "contribute-to-eliza");
  const archiveFiles = options.archiveFiles ?? canonicalFiles;
  for (const [path, contents] of Object.entries(archiveFiles)) {
    const destination = join(stagedSkill, ...path.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }
  const manifest = Object.entries(archiveFiles)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, contents]) => ({ path, sha256: sha256(contents) }));
  const skill = archiveFiles["SKILL.md"];
  if (!skill) throw new TypeError("artifact fixture omitted SKILL.md");
  writeFileSync(
    join(stagedSkill, "PROVENANCE.json"),
    `${JSON.stringify(
      {
        schemaVersion: "1",
        name: "contribute-to-eliza",
        repository: "elizaOS/eliza",
        revision:
          options.provenanceRevision === undefined
            ? revision
            : options.provenanceRevision,
        revisionStatus: options.revisionStatus ?? "committed",
        source: {
          path: "packages/skills/skills/contribute-to-eliza/SKILL.md",
          sha256: sha256(skill),
        },
        files: manifest,
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(dirname(archivePath), { recursive: true });
  execFileSync(
    "python3",
    [
      "-c",
      `
import os
import stat
import sys
import zipfile

source, archive_path = sys.argv[1:]
with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for directory, _, names in os.walk(source):
        for name in sorted(names):
            path = os.path.join(directory, name)
            relative = os.path.relpath(path, os.path.dirname(source)).replace(os.sep, "/")
            entry = zipfile.ZipInfo(relative, (1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            with open(path, "rb") as contents:
                archive.writestr(entry, contents.read())
`,
      stagedSkill,
      archivePath,
    ],
    { cwd: repositoryRoot },
  );
  execFileSync("python3", [normalizeArchive, archivePath], {
    cwd: repositoryRoot,
  });
  writeFileSync(
    `${archivePath}.sha256`,
    `${sha256(readFileSync(archivePath))}  contribute-to-eliza.skill\n`,
  );
  return publicRoot;
}

function configureAuthority(root: string, options: AuthorityFixtureOptions) {
  return createInstallAuthorityFixture(join(root, "authority"), options);
}

function command(
  artifactRoot: string,
  authority: { apiOrigin: string; rawOrigin: string },
): string {
  return createInstallCommand(
    pathToFileURL(artifactRoot).href.replace(/\/$/u, ""),
    `\${CODEX_HOME:-\${HOME}/.codex}/skills`,
    { testAuthority: authority },
  );
}

function run(
  script: string,
  installationRoot: string,
  environment: Record<string, string> = {},
) {
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: join(installationRoot, "codex"),
      HOME: join(installationRoot, "home"),
      ...environment,
    },
  });
}

function currentLink(root: string): string {
  return readlinkSync(join(root, "codex", "skills", "contribute-to-eliza"));
}

function versionPath(root: string, revision: string): string {
  return join(
    root,
    "codex",
    "skills",
    ".contribute-to-eliza-versions",
    revision,
  );
}

function candidatePull(
  revision: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    base: { ref: "develop", repo: { full_name: "elizaOS/eliza" } },
    draft: false,
    head: { repo: { full_name: "elizaOS/eliza" }, sha: revision },
    labels: [{ name: "eliza-army-release-candidate" }],
    number: 17424,
    state: "open",
    ...overrides,
  };
}

function freshCandidateTimeline(revision: string): unknown[] {
  return [
    { event: "committed", sha: revision },
    {
      event: "labeled",
      label: { name: "eliza-army-release-candidate" },
    },
  ];
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { force: true, recursive: true });
  }
});

describe("authenticated skill installer lifecycle", () => {
  it("installs current develop, no-ops at the same revision, and atomically advances to an ancestor", () => {
    const root = freshRoot("advance");
    const installRoot = join(root, "install");
    const filesA = baseFiles("revision-a");
    const filesB = baseFiles("revision-b");
    const artifactA = writeArtifact(root, revisionA, filesA);
    const artifactB = writeArtifact(root, revisionB, filesB);
    let authority = configureAuthority(root, {
      developHead: revisionA,
      revisions: { [revisionA]: { files: filesA } },
    });

    const initial = run(command(artifactA, authority), installRoot);
    expect(initial.status, initial.stderr).toBe(0);
    expect(currentLink(installRoot)).toBe(
      `.contribute-to-eliza-versions/${revisionA}`,
    );
    expect(
      readFileSync(join(versionPath(installRoot, revisionA), "SKILL.md")),
    ).toEqual(filesA["SKILL.md"]);
    expect(
      JSON.parse(
        readFileSync(
          join(
            versionPath(installRoot, revisionA),
            ".eliza-army-authorization.json",
          ),
          "utf8",
        ),
      ),
    ).toMatchObject({
      authorization: { kind: "develop" },
      revision: revisionA,
    });

    const unchanged = run(command(artifactA, authority), installRoot);
    expect(unchanged.status, unchanged.stderr).toBe(0);
    expect(unchanged.stdout).toContain("no changes made");
    expect(currentLink(installRoot)).toBe(
      `.contribute-to-eliza-versions/${revisionA}`,
    );

    unlinkSync(join(installRoot, "codex", "skills", "contribute-to-eliza"));
    const interruptedActivation = run(
      command(artifactA, authority),
      installRoot,
    );
    expect(interruptedActivation.status, interruptedActivation.stderr).toBe(0);
    expect(currentLink(installRoot)).toBe(
      `.contribute-to-eliza-versions/${revisionA}`,
    );

    authority = configureAuthority(root, {
      comparisons: {
        [`${revisionA}...${revisionB}`]: aheadComparison(revisionA, revisionB),
      },
      developHead: revisionB,
      revisions: {
        [revisionA]: { files: filesA },
        [revisionB]: { files: filesB },
      },
    });
    const update = run(command(artifactB, authority), installRoot);
    expect(update.status, update.stderr).toBe(0);
    expect(currentLink(installRoot)).toBe(
      `.contribute-to-eliza-versions/${revisionB}`,
    );
    expect(existsSync(versionPath(installRoot, revisionA))).toBe(true);
    expect(existsSync(versionPath(installRoot, revisionB))).toBe(true);
  });

  it("rejects a downgrade or divergent update and leaves the active symlink untouched", () => {
    const root = freshRoot("downgrade");
    const installRoot = join(root, "install");
    const filesA = baseFiles("revision-a");
    const filesB = baseFiles("revision-b");
    const artifactB = writeArtifact(root, revisionB, filesB);
    const artifactA = writeArtifact(root, revisionA, filesA);
    let authority = configureAuthority(root, {
      developHead: revisionB,
      revisions: { [revisionB]: { files: filesB } },
    });
    expect(run(command(artifactB, authority), installRoot).status).toBe(0);

    authority = configureAuthority(root, {
      comparisons: {
        [`${revisionB}...${revisionA}`]: {
          ahead_by: 0,
          base_commit: { sha: revisionB },
          behind_by: 1,
          merge_base_commit: { sha: revisionA },
          status: "behind",
        },
      },
      developHead: revisionA,
      revisions: {
        [revisionA]: { files: filesA },
        [revisionB]: { files: filesB },
      },
    });
    const downgrade = run(command(artifactA, authority), installRoot);
    expect(downgrade.status).not.toBe(0);
    expect(downgrade.stderr).toContain("downgrade or divergent");
    expect(currentLink(installRoot)).toBe(
      `.contribute-to-eliza-versions/${revisionB}`,
    );
    expect(existsSync(versionPath(installRoot, revisionA))).toBe(false);
  });

  it("keeps an unchanged deployed skill available across unrelated develop commits", () => {
    const unchangedRoot = freshRoot("develop-history-unchanged");
    const filesA = baseFiles("canonical-skill");
    const artifact = writeArtifact(unchangedRoot, revisionA, filesA);
    const unchangedAuthority = configureAuthority(unchangedRoot, {
      comparisons: {
        [`${revisionA}...${revisionB}`]: aheadComparison(revisionA, revisionB),
      },
      developHead: revisionB,
      revisions: {
        [revisionA]: { files: filesA },
        [revisionB]: { files: filesA },
      },
    });
    const accepted = run(
      command(artifact, unchangedAuthority),
      join(unchangedRoot, "install"),
    );
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(currentLink(join(unchangedRoot, "install"))).toBe(
      `.contribute-to-eliza-versions/${revisionA}`,
    );

    const staleRoot = freshRoot("develop-history-stale");
    const staleArtifact = writeArtifact(staleRoot, revisionA, filesA);
    const changedAuthority = configureAuthority(staleRoot, {
      comparisons: {
        [`${revisionA}...${revisionB}`]: aheadComparison(revisionA, revisionB),
      },
      developHead: revisionB,
      revisions: {
        [revisionA]: { files: filesA },
        [revisionB]: { files: baseFiles("changed-canonical-skill") },
      },
    });
    const rejected = run(
      command(staleArtifact, changedAuthority),
      join(staleRoot, "install"),
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("canonical skill bytes changed");
  });

  it("accepts only an exact open labeled same-repository non-draft PR head", () => {
    const filesA = baseFiles("develop");
    const filesC = baseFiles("candidate");
    const cases = [
      ["draft", { draft: true }],
      [
        "fork",
        { head: { repo: { full_name: "someone/fork" }, sha: revisionC } },
      ],
      ["closed", { state: "closed" }],
      ["unlabeled", { labels: [{ name: "safe-to-test" }] }],
      [
        "wrong head",
        { head: { repo: { full_name: "elizaOS/eliza" }, sha: revisionB } },
      ],
    ] as const;

    for (const [label, overrides] of cases) {
      const root = freshRoot(`candidate-${label.replaceAll(" ", "-")}`);
      const artifact = writeArtifact(root, revisionC, filesC);
      const authority = configureAuthority(root, {
        comparisons: {
          [`${revisionC}...${revisionA}`]: {
            ahead_by: 0,
            base_commit: { sha: revisionC },
            behind_by: 1,
            merge_base_commit: { sha: revisionA },
            status: "diverged",
          },
        },
        developHead: revisionA,
        revisions: {
          [revisionA]: { files: filesA },
          [revisionC]: {
            files: filesC,
            pulls: [candidatePull(revisionC, overrides)],
          },
        },
      });
      const rejected = run(command(artifact, authority), join(root, "install"));
      expect(rejected.status, label).not.toBe(0);
      expect(rejected.stderr, label).toContain(
        "neither the current canonical develop skill",
      );
    }

    const acceptedRoot = freshRoot("candidate-accepted");
    const acceptedArtifact = writeArtifact(acceptedRoot, revisionC, filesC);
    const acceptedAuthority = configureAuthority(acceptedRoot, {
      comparisons: {
        [`${revisionA}...${revisionC}`]: aheadComparison(revisionA, revisionC),
      },
      developHead: revisionA,
      revisions: {
        [revisionA]: { files: filesA },
        [revisionC]: {
          files: filesC,
          pulls: [candidatePull(revisionC)],
        },
      },
      timelines: { 17424: freshCandidateTimeline(revisionC) },
    });
    const accepted = run(
      command(acceptedArtifact, acceptedAuthority),
      join(acceptedRoot, "install"),
    );
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(
      JSON.parse(
        readFileSync(
          join(
            versionPath(join(acceptedRoot, "install"), revisionC),
            ".eliza-army-authorization.json",
          ),
          "utf8",
        ),
      ),
    ).toMatchObject({ authorization: { kind: "candidate", pull: 17424 } });

    const staleRoot = freshRoot("candidate-stale-approval");
    const staleArtifact = writeArtifact(staleRoot, revisionC, filesC);
    const staleAuthority = configureAuthority(staleRoot, {
      comparisons: {
        [`${revisionA}...${revisionC}`]: aheadComparison(revisionA, revisionC),
      },
      developHead: revisionA,
      revisions: {
        [revisionA]: { files: filesA },
        [revisionC]: {
          files: filesC,
          pulls: [candidatePull(revisionC)],
        },
      },
      timelines: {
        17424: [
          {
            event: "labeled",
            label: { name: "eliza-army-release-candidate" },
          },
          { event: "committed", sha: revisionC },
        ],
      },
    });
    const stale = run(
      command(staleArtifact, staleAuthority),
      join(staleRoot, "install"),
    );
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain("not bound to the current");

    const behindRoot = freshRoot("candidate-behind-develop");
    const behindArtifact = writeArtifact(behindRoot, revisionC, filesC);
    const behindAuthority = configureAuthority(behindRoot, {
      comparisons: {
        [`${revisionA}...${revisionC}`]: {
          ahead_by: 1,
          base_commit: { sha: revisionB },
          behind_by: 1,
          merge_base_commit: { sha: revisionB },
          status: "diverged",
        },
      },
      developHead: revisionA,
      revisions: {
        [revisionA]: { files: filesA },
        [revisionC]: {
          files: filesC,
          pulls: [candidatePull(revisionC)],
        },
      },
      timelines: { 17424: freshCandidateTimeline(revisionC) },
    });
    const behind = run(
      command(behindArtifact, behindAuthority),
      join(behindRoot, "install"),
    );
    expect(behind.status).not.toBe(0);
    expect(behind.stderr).toContain("behind or divergent");
  });

  it("allows a labeled candidate to transition to its squash-merged develop result", () => {
    const root = freshRoot("candidate-merge");
    const installRoot = join(root, "install");
    const filesA = baseFiles("develop-before");
    const filesC = baseFiles("candidate");
    const filesD = baseFiles("merged-result");
    const candidateArtifact = writeArtifact(root, revisionC, filesC);
    const mergedArtifact = writeArtifact(root, revisionD, filesD);
    let authority = configureAuthority(root, {
      comparisons: {
        [`${revisionA}...${revisionC}`]: aheadComparison(revisionA, revisionC),
      },
      developHead: revisionA,
      revisions: {
        [revisionA]: { files: filesA },
        [revisionC]: { files: filesC, pulls: [candidatePull(revisionC)] },
      },
      timelines: { 17424: freshCandidateTimeline(revisionC) },
    });
    expect(run(command(candidateArtifact, authority), installRoot).status).toBe(
      0,
    );

    authority = configureAuthority(root, {
      comparisons: {
        [`${revisionC}...${revisionD}`]: {
          ahead_by: 1,
          base_commit: { sha: revisionC },
          behind_by: 1,
          merge_base_commit: { sha: revisionA },
          status: "diverged",
        },
      },
      developHead: revisionD,
      revisions: {
        [revisionC]: {
          files: filesC,
          pulls: [
            candidatePull(revisionC, {
              labels: [],
              merge_commit_sha: revisionD,
              merged_at: "2026-07-31T12:00:00Z",
              state: "closed",
            }),
          ],
        },
        [revisionD]: { files: filesD },
      },
    });
    const merged = run(command(mergedArtifact, authority), installRoot);
    expect(merged.status, merged.stderr).toBe(0);
    expect(currentLink(installRoot)).toBe(
      `.contribute-to-eliza-versions/${revisionD}`,
    );
    expect(existsSync(versionPath(installRoot, revisionC))).toBe(true);
  });

  it("rolls back only to a retained, remotely reverified, unmodified revision", () => {
    const root = freshRoot("rollback");
    const installRoot = join(root, "install");
    const filesA = baseFiles("revision-a");
    const filesB = baseFiles("revision-b");
    const artifactA = writeArtifact(root, revisionA, filesA);
    const artifactB = writeArtifact(root, revisionB, filesB);
    let authority = configureAuthority(root, {
      developHead: revisionA,
      revisions: { [revisionA]: { files: filesA } },
    });
    expect(run(command(artifactA, authority), installRoot).status).toBe(0);
    authority = configureAuthority(root, {
      comparisons: {
        [`${revisionA}...${revisionB}`]: aheadComparison(revisionA, revisionB),
      },
      developHead: revisionB,
      revisions: {
        [revisionA]: { files: filesA },
        [revisionB]: { files: filesB },
      },
    });
    expect(run(command(artifactB, authority), installRoot).status).toBe(0);

    const rollback = run(command(artifactB, authority), installRoot, {
      ELIZA_ARMY_SKILL_OPERATION: "rollback",
      ELIZA_ARMY_SKILL_REVISION: revisionA,
    });
    expect(rollback.status, rollback.stderr).toBe(0);
    expect(currentLink(installRoot)).toBe(
      `.contribute-to-eliza-versions/${revisionA}`,
    );

    writeFileSync(
      join(versionPath(installRoot, revisionB), "references", "revision.txt"),
      "locally modified\n",
    );
    const modified = run(command(artifactB, authority), installRoot, {
      ELIZA_ARMY_SKILL_OPERATION: "rollback",
      ELIZA_ARMY_SKILL_REVISION: revisionB,
    });
    expect(modified.status).not.toBe(0);
    expect(modified.stderr).toContain("differs from GitHub");
    expect(currentLink(installRoot)).toBe(
      `.contribute-to-eliza-versions/${revisionA}`,
    );

    const missing = run(command(artifactB, authority), installRoot, {
      ELIZA_ARMY_SKILL_OPERATION: "rollback",
      ELIZA_ARMY_SKILL_REVISION: revisionC,
    });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("not retained locally");
  });

  it("rejects working-tree provenance and same-origin bytes that differ from GitHub", () => {
    const filesA = baseFiles("canonical");

    const workingRoot = freshRoot("working-tree");
    const workingArtifact = writeArtifact(workingRoot, revisionA, filesA, {
      provenanceRevision: null,
      revisionStatus: "working-tree",
    });
    const workingAuthority = configureAuthority(workingRoot, {
      developHead: revisionA,
      revisions: { [revisionA]: { files: filesA } },
    });
    const working = run(
      command(workingArtifact, workingAuthority),
      join(workingRoot, "install"),
    );
    expect(working.status).not.toBe(0);

    const forgedRoot = freshRoot("same-origin-forgery");
    const forgedFiles = {
      ...filesA,
      "references/revision.txt": Buffer.from("origin-controlled forgery\n"),
    };
    const forgedArtifact = writeArtifact(forgedRoot, revisionA, filesA, {
      archiveFiles: forgedFiles,
    });
    const forgedAuthority = configureAuthority(forgedRoot, {
      developHead: revisionA,
      revisions: { [revisionA]: { files: filesA } },
    });
    const forged = run(
      command(forgedArtifact, forgedAuthority),
      join(forgedRoot, "install"),
    );
    expect(forged.status).not.toBe(0);
    expect(forged.stderr).toMatch(/provenance digest disagrees|bytes disagree/);
  });

  it("rejects unbounded or non-regular canonical GitHub Contents entries", () => {
    const boundedRoot = freshRoot("source-file-bound");
    const archiveFiles = baseFiles("bounded archive");
    const remoteFiles = {
      "SKILL.md": archiveFiles["SKILL.md"],
      ...Object.fromEntries(
        Array.from({ length: 32 }, (_, index) => [
          `references/file-${index.toString().padStart(2, "0")}.md`,
          `remote file ${index}\n`,
        ]),
      ),
    };
    const boundedArtifact = writeArtifact(boundedRoot, revisionA, archiveFiles);
    const boundedAuthority = configureAuthority(boundedRoot, {
      developHead: revisionA,
      revisions: { [revisionA]: { files: remoteFiles } },
    });
    const bounded = run(
      command(boundedArtifact, boundedAuthority),
      join(boundedRoot, "install"),
    );
    expect(bounded.status).not.toBe(0);
    expect(bounded.stderr).toContain("file count exceeds its bound");

    const symlinkRoot = freshRoot("source-symlink");
    const symlinkArtifact = writeArtifact(symlinkRoot, revisionA, archiveFiles);
    const contentsKey =
      "/repos/elizaOS/eliza/contents/packages/skills/skills/contribute-to-eliza" +
      `?ref=${revisionA}`;
    const symlinkAuthority = configureAuthority(symlinkRoot, {
      developHead: revisionA,
      responseOverrides: {
        [contentsKey]: [
          {
            name: "SKILL.md",
            path: "packages/skills/skills/contribute-to-eliza/SKILL.md",
            sha: "0".repeat(40),
            size: archiveFiles["SKILL.md"].length,
            type: "symlink",
          },
        ],
      },
      revisions: { [revisionA]: { files: archiveFiles } },
    });
    const symlink = run(
      command(symlinkArtifact, symlinkAuthority),
      join(symlinkRoot, "install"),
    );
    expect(symlink.status).not.toBe(0);
    expect(symlink.stderr).toContain("non-regular");
  });

  it("permits test-only file authorities but fixes production authority hosts", () => {
    const production = createInstallCommand(
      "https://eliza.army",
      `\${HOME}/.codex/skills`,
    );
    expect(production).toContain("'https://api.github.com'");
    expect(production).toContain("'https://raw.githubusercontent.com'");
    expect(production).not.toContain("GITHUB_API_ORIGIN");
    expect(() =>
      createInstallCommand("https://eliza.army", `\${HOME}/.codex/skills`, {
        testAuthority: {
          apiOrigin: "https://attacker.example",
          rawOrigin: "https://attacker.example",
        },
      }),
    ).toThrow("must be an unparameterized file:// origin");
  });

  it("uses a process-bound lock that recovers after an interrupted holder", async () => {
    const filesA = baseFiles("revision-a");
    const lockedRoot = freshRoot("locked");
    const lockedArtifact = writeArtifact(lockedRoot, revisionA, filesA);
    const lockedAuthority = configureAuthority(lockedRoot, {
      developHead: revisionA,
      revisions: { [revisionA]: { files: filesA } },
    });
    const lock = join(
      lockedRoot,
      "install",
      "codex",
      "skills",
      ".contribute-to-eliza.lock",
    );
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "");
    const holder = spawn(
      "python3",
      [
        "-c",
        "import fcntl,sys,time; f=open(sys.argv[1],'a+b'); fcntl.flock(f,fcntl.LOCK_EX); print('locked',flush=True); time.sleep(60)",
        lock,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise<void>((resolvePromise, rejectPromise) => {
      holder.once("error", rejectPromise);
      holder.stdout.once("data", (value) => {
        if (String(value).includes("locked")) resolvePromise();
        else
          rejectPromise(new Error(`unexpected lock holder output: ${value}`));
      });
    });
    const locked = run(
      command(lockedArtifact, lockedAuthority),
      join(lockedRoot, "install"),
    );
    expect(locked.status).not.toBe(0);
    expect(locked.stderr).toContain("concurrency lock");
    holder.kill("SIGKILL");
    await new Promise<void>((resolvePromise) =>
      holder.once("close", () => resolvePromise()),
    );

    const recovered = run(
      command(lockedArtifact, lockedAuthority),
      join(lockedRoot, "install"),
    );
    expect(recovered.status, recovered.stderr).toBe(0);
  });

  it("refuses unmanaged or broken install targets", () => {
    const filesA = baseFiles("revision-a");

    const unmanagedRoot = freshRoot("unmanaged");
    const unmanagedArtifact = writeArtifact(unmanagedRoot, revisionA, filesA);
    const unmanagedAuthority = configureAuthority(unmanagedRoot, {
      developHead: revisionA,
      revisions: { [revisionA]: { files: filesA } },
    });
    const unmanagedTarget = join(
      unmanagedRoot,
      "install",
      "codex",
      "skills",
      "contribute-to-eliza",
    );
    mkdirSync(dirname(unmanagedTarget), { recursive: true });
    writeFileSync(unmanagedTarget, "must remain untouched\n");
    const unmanaged = run(
      command(unmanagedArtifact, unmanagedAuthority),
      join(unmanagedRoot, "install"),
    );
    expect(unmanaged.status).not.toBe(0);
    expect(unmanaged.stderr).toContain("not an installer-managed symlink");
    expect(readFileSync(unmanagedTarget, "utf8")).toBe(
      "must remain untouched\n",
    );
  });
});
