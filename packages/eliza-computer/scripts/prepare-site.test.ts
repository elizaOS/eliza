/**
 * Verifies that the published skill archive is a complete, checksum-bound copy
 * of the canonical skill and that its generated install command fails closed.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "..", "..");
const skillRoot = join(
  repositoryRoot,
  "packages",
  "skills",
  "skills",
  "contribute-to-eliza",
);
const publicRoot = join(packageRoot, "public");
const archivePath = join(publicRoot, "downloads", "contribute-to-eliza.skill");
const checksumPath = `${archivePath}.sha256`;

type JsonRecord = Record<string, unknown>;

interface ArchiveInspection {
  names: string[];
  hashes: Record<string, string>;
  provenance: {
    schemaVersion: string;
    name: string;
    repository: string;
    revision: string | null;
    revisionStatus: "committed" | "working-tree";
    source: { path: string; sha256: string };
    files: { path: string; sha256: string }[];
  };
}

function sha256(contents: Buffer | string) {
  return createHash("sha256").update(contents).digest("hex");
}

function asRecord(value: unknown, context: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${context} must be a JSON object`);
  }
  return value as JsonRecord;
}

function asString(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${context} must be a string`);
  }
  return value;
}

function parseJsonRecord(contents: string, context: string): JsonRecord {
  return asRecord(JSON.parse(contents), context);
}

function listFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new TypeError(`skill packages may not contain symlinks: ${path}`);
    }
    if (entry.isDirectory()) return listFiles(path);
    if (!entry.isFile()) {
      throw new TypeError(`skill packages may contain only files: ${path}`);
    }
    return [relative(skillRoot, path).replaceAll("\\", "/")];
  });
}

function inspectArchive() {
  const script = `
import hashlib
import json
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    names = [entry.filename for entry in archive.infolist()]
    result = {
        "names": names,
        "hashes": {
            name: hashlib.sha256(archive.read(name)).hexdigest()
            for name in names
        },
        "provenance": json.loads(
            archive.read("contribute-to-eliza/PROVENANCE.json")
        ),
    }
print(json.dumps(result))
`;
  const parsed = parseJsonRecord(
    execFileSync("python3", ["-c", script, archivePath], {
      encoding: "utf8",
    }),
    "archive inspection",
  );
  if (
    !Array.isArray(parsed.names) ||
    parsed.names.some((name) => typeof name !== "string")
  ) {
    throw new TypeError("archive inspection.names must be strings");
  }
  const names = parsed.names as string[];
  const rawHashes = asRecord(parsed.hashes, "archive inspection.hashes");
  const hashes = Object.fromEntries(
    Object.entries(rawHashes).map(([name, digest]) => [
      name,
      asString(digest, `archive inspection.hashes.${name}`),
    ]),
  );
  const rawProvenance = asRecord(
    parsed.provenance,
    "archive inspection.provenance",
  );
  const rawSource = asRecord(
    rawProvenance.source,
    "archive inspection.provenance.source",
  );
  const revision =
    rawProvenance.revision === null
      ? null
      : asString(
          rawProvenance.revision,
          "archive inspection.provenance.revision",
        );
  const revisionStatus = asString(
    rawProvenance.revisionStatus,
    "archive inspection.provenance.revisionStatus",
  );
  if (!["committed", "working-tree"].includes(revisionStatus)) {
    throw new TypeError("archive provenance has an invalid revisionStatus");
  }
  return {
    names,
    hashes,
    provenance: {
      schemaVersion: asString(
        rawProvenance.schemaVersion,
        "archive inspection.provenance.schemaVersion",
      ),
      name: asString(rawProvenance.name, "archive inspection.provenance.name"),
      repository: asString(
        rawProvenance.repository,
        "archive inspection.provenance.repository",
      ),
      revision,
      revisionStatus:
        revisionStatus as ArchiveInspection["provenance"]["revisionStatus"],
      source: {
        path: asString(
          rawSource.path,
          "archive inspection.provenance.source.path",
        ),
        sha256: asString(
          rawSource.sha256,
          "archive inspection.provenance.source.sha256",
        ),
      },
      files: Array.isArray(rawProvenance.files)
        ? rawProvenance.files.map((entry, index) => {
            const record = asRecord(
              entry,
              `archive inspection.provenance.files[${index}]`,
            );
            return {
              path: asString(
                record.path,
                `archive inspection.provenance.files[${index}].path`,
              ),
              sha256: asString(
                record.sha256,
                `archive inspection.provenance.files[${index}].sha256`,
              ),
            };
          })
        : (() => {
            throw new TypeError(
              "archive inspection.provenance.files must be an array",
            );
          })(),
    },
  };
}

function installCommand() {
  const bootstrap = readFileSync(join(publicRoot, "codex.md"), "utf8");
  const command = bootstrap.match(/```bash\n([\s\S]*?)\n```/)?.[1];
  if (!command) throw new TypeError("codex.md omitted its bash install block");
  const localOrigin = pathToFileURL(publicRoot).href.replace(/\/$/, "");
  return command.replaceAll("https://eliza.army", localOrigin);
}

function runInstall(
  command: string,
  root: string,
  { codexHome = true }: { codexHome?: boolean } = {},
) {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(root, "home"),
  };
  if (codexHome) {
    environment.CODEX_HOME = join(root, "codex");
  } else {
    delete environment.CODEX_HOME;
  }
  return spawnSync("bash", ["-c", command], {
    cwd: packageRoot,
    encoding: "utf8",
    env: environment,
  });
}

beforeAll(() => {
  execFileSync("node", [join(packageRoot, "scripts", "prepare-site.mjs")], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
});

describe("contribution skill package", () => {
  it("packages byte-identical skill archives for identical source and revision", () => {
    const firstArchive = readFileSync(archivePath);
    execFileSync("node", [join(packageRoot, "scripts", "prepare-site.mjs")], {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
    expect(readFileSync(archivePath)).toEqual(firstArchive);
  });

  it("contains every canonical dependency, no extra source, and bound provenance", () => {
    const archive = inspectArchive();
    const canonicalFiles = listFiles(skillRoot).sort();
    const expectedNames = [
      ...canonicalFiles.map((path) => `contribute-to-eliza/${path}`),
      "contribute-to-eliza/PROVENANCE.json",
    ].sort();

    expect([...archive.names].sort()).toEqual(expectedNames);
    expect(new Set(archive.names).size).toBe(archive.names.length);
    for (const path of canonicalFiles) {
      expect(archive.hashes[`contribute-to-eliza/${path}`]).toBe(
        sha256(readFileSync(join(skillRoot, path))),
      );
    }

    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
    const sourceStatus = execFileSync(
      "git",
      [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        "packages/skills/skills/contribute-to-eliza",
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    ).trim();

    expect(archive.provenance).toMatchObject({
      schemaVersion: "1",
      name: "contribute-to-eliza",
      repository: "elizaOS/eliza",
      revision: sourceStatus.length === 0 ? head : null,
      revisionStatus: sourceStatus.length === 0 ? "committed" : "working-tree",
      source: {
        path: "packages/skills/skills/contribute-to-eliza/SKILL.md",
        sha256: sha256(readFileSync(join(skillRoot, "SKILL.md"))),
      },
    });
    expect(archive.provenance.files).toEqual(
      canonicalFiles.map((path) => ({
        path,
        sha256: sha256(readFileSync(join(skillRoot, path))),
      })),
    );
  });

  it("rejects ignored source files instead of packaging them as committed provenance", () => {
    const ignoredExtra = join(skillRoot, "ignored-provenance-fixture.tmp");
    try {
      writeFileSync(
        ignoredExtra,
        "must never enter the public skill archive\n",
      );
      const ignored = spawnSync(
        "git",
        ["check-ignore", "--quiet", ignoredExtra],
        {
          cwd: repositoryRoot,
        },
      );
      expect(ignored.status).toBe(0);

      const result = spawnSync(
        "node",
        [join(packageRoot, "scripts", "prepare-site.mjs")],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "skill source must exactly match tracked files",
      );
      expect(result.stderr).toContain("ignored-provenance-fixture.tmp");
    } finally {
      rmSync(ignoredExtra, { force: true });
    }
  });

  it("publishes matching source, archive, checksum, manifest, and standalone mission", () => {
    const archive = readFileSync(archivePath);
    const skill = readFileSync(join(skillRoot, "SKILL.md"));
    const checksum = readFileSync(checksumPath, "utf8");
    const manifest = parseJsonRecord(
      readFileSync(join(publicRoot, "skill-manifest.json"), "utf8"),
      "skill manifest",
    );
    const mission = readFileSync(join(publicRoot, "mission.md"), "utf8");
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();

    expect(
      readFileSync(join(publicRoot, "brand", "ogembeds", "eliza_ogembed.png")),
    ).toEqual(
      readFileSync(
        join(
          repositoryRoot,
          "packages",
          "shared",
          "assets",
          "ogembeds",
          "eliza_ogembed.png",
        ),
      ),
    );
    expect(readFileSync(join(publicRoot, "skill.md"))).toEqual(skill);
    expect(checksum).toBe(`${sha256(archive)}  contribute-to-eliza.skill\n`);
    expect(manifest).toMatchObject({
      schemaVersion: "1",
      name: "contribute-to-eliza",
      repository: "elizaOS/eliza",
      archive: { sha256: sha256(archive) },
      source: {
        sha256: sha256(skill),
        path: "packages/skills/skills/contribute-to-eliza/SKILL.md",
        url: `https://github.com/elizaOS/eliza/blob/${head}/packages/skills/skills/contribute-to-eliza/SKILL.md`,
        publicUrl: "https://eliza.army/skill.md",
      },
    });
    expect(asRecord(manifest.archive, "skill manifest.archive")).toMatchObject({
      url: "https://eliza.army/downloads/contribute-to-eliza.skill",
      checksumUrl:
        "https://eliza.army/downloads/contribute-to-eliza.skill.sha256",
    });
    expect(
      Number.isNaN(
        Date.parse(
          asString(manifest.generatedAt, "skill manifest.generatedAt"),
        ),
      ),
    ).toBe(false);
    expect(mission).toContain(skill.toString());
    expect(mission).toContain(
      readFileSync(
        join(skillRoot, "references", "repository-contract.md"),
        "utf8",
      ),
    );
    expect(mission).toContain(
      readFileSync(
        join(skillRoot, "references", "evidence-review-rubric.md"),
        "utf8",
      ),
    );
  });

  it("installs the verified archive and refuses mismatched or ambiguous checksums", () => {
    const validRoot = mkdtempSync(join(tmpdir(), "eliza-skill-install-valid-"));
    const invalidRoot = mkdtempSync(
      join(tmpdir(), "eliza-skill-install-invalid-"),
    );
    const ambiguousRoot = mkdtempSync(
      join(tmpdir(), "eliza-skill-install-ambiguous-"),
    );
    const defaultRoot = mkdtempSync(
      join(tmpdir(), "eliza-skill-install-default-home-"),
    );
    const corruptPublic = join(invalidRoot, "public");
    const ambiguousPublic = join(ambiguousRoot, "public");
    try {
      const command = installCommand();
      expect(command).toContain(
        `SKILLS_ROOT="\${CODEX_HOME:-\${HOME}/.codex}/skills"`,
      );
      expect(command).not.toContain('SKILLS_ROOT="\\${CODEX_HOME');

      const valid = runInstall(command, validRoot);
      expect(valid.status, valid.stderr).toBe(0);
      const installedRoot = join(
        validRoot,
        "codex",
        "skills",
        "contribute-to-eliza",
      );
      expect(readFileSync(join(installedRoot, "SKILL.md"))).toEqual(
        readFileSync(join(skillRoot, "SKILL.md")),
      );
      const installedProvenance = parseJsonRecord(
        readFileSync(join(installedRoot, "PROVENANCE.json"), "utf8"),
        "installed provenance",
      );
      expect(
        asString(
          asRecord(installedProvenance.source, "installed provenance.source")
            .sha256,
          "installed provenance.source.sha256",
        ),
      ).toBe(sha256(readFileSync(join(skillRoot, "SKILL.md"))));
      const defaultInstall = runInstall(command, defaultRoot, {
        codexHome: false,
      });
      expect(defaultInstall.status, defaultInstall.stderr).toBe(0);
      expect(
        existsSync(
          join(
            defaultRoot,
            "home",
            ".codex",
            "skills",
            "contribute-to-eliza",
            "SKILL.md",
          ),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(
            packageRoot,
            `\${CODEX_HOME:-\${HOME}`,
            ".codex}",
            "skills",
            "contribute-to-eliza",
          ),
        ),
      ).toBe(false);
      const sentinel = "existing local skill must not be overwritten\n";
      writeFileSync(join(installedRoot, "SKILL.md"), sentinel);
      const overwrite = runInstall(command, validRoot);
      expect(overwrite.status).not.toBe(0);
      expect(overwrite.stderr).toContain(
        "Refusing to overwrite existing skill",
      );
      expect(readFileSync(join(installedRoot, "SKILL.md"), "utf8")).toBe(
        sentinel,
      );

      mkdirSync(join(corruptPublic, "downloads"), { recursive: true });
      cpSync(
        checksumPath,
        join(corruptPublic, "downloads", "contribute-to-eliza.skill.sha256"),
      );
      const corruptArchive = readFileSync(archivePath);
      corruptArchive[corruptArchive.length - 1] ^= 0xff;
      writeFileSync(
        join(corruptPublic, "downloads", "contribute-to-eliza.skill"),
        corruptArchive,
      );
      const corruptCommand = installCommand().replaceAll(
        pathToFileURL(publicRoot).href.replace(/\/$/, ""),
        pathToFileURL(corruptPublic).href.replace(/\/$/, ""),
      );
      const invalid = runInstall(corruptCommand, invalidRoot);
      expect(invalid.status).not.toBe(0);
      expect(() =>
        readFileSync(
          join(
            invalidRoot,
            "codex",
            "skills",
            "contribute-to-eliza",
            "SKILL.md",
          ),
        ),
      ).toThrow();

      mkdirSync(join(ambiguousPublic, "downloads"), { recursive: true });
      cpSync(
        archivePath,
        join(ambiguousPublic, "downloads", "contribute-to-eliza.skill"),
      );
      const validChecksum = readFileSync(checksumPath, "utf8");
      writeFileSync(
        join(ambiguousPublic, "downloads", "contribute-to-eliza.skill.sha256"),
        `${validChecksum}${validChecksum}`,
      );
      const ambiguousCommand = installCommand().replaceAll(
        pathToFileURL(publicRoot).href.replace(/\/$/, ""),
        pathToFileURL(ambiguousPublic).href.replace(/\/$/, ""),
      );
      const ambiguous = runInstall(ambiguousCommand, ambiguousRoot);
      expect(ambiguous.status).not.toBe(0);
      expect(() =>
        readFileSync(
          join(
            ambiguousRoot,
            "codex",
            "skills",
            "contribute-to-eliza",
            "SKILL.md",
          ),
        ),
      ).toThrow();
    } finally {
      rmSync(validRoot, { force: true, recursive: true });
      rmSync(invalidRoot, { force: true, recursive: true });
      rmSync(ambiguousRoot, { force: true, recursive: true });
      rmSync(defaultRoot, { force: true, recursive: true });
    }
  });

  it("rejects unsafe archive paths, symlinks, and broken target symlinks", () => {
    const traversalRoot = mkdtempSync(
      join(tmpdir(), "eliza-skill-install-traversal-"),
    );
    const symlinkArchiveRoot = mkdtempSync(
      join(tmpdir(), "eliza-skill-install-symlink-"),
    );
    const brokenTargetRoot = mkdtempSync(
      join(tmpdir(), "eliza-skill-install-broken-target-"),
    );

    function maliciousCommand(
      root: string,
      mode: "traversal" | "symlink",
    ): string {
      const maliciousPublic = join(root, "public");
      const maliciousDownloads = join(maliciousPublic, "downloads");
      const maliciousArchive = join(
        maliciousDownloads,
        "contribute-to-eliza.skill",
      );
      mkdirSync(maliciousDownloads, { recursive: true });
      execFileSync(
        "python3",
        [
          "-c",
          `
import stat
import sys
import zipfile

archive_path, mode = sys.argv[1:]
with zipfile.ZipFile(archive_path, "w") as archive:
    archive.writestr("contribute-to-eliza/SKILL.md", "---\\nname: contribute-to-eliza\\ndescription: fixture\\n---\\n")
    archive.writestr("contribute-to-eliza/PROVENANCE.json", "{}\\n")
    if mode == "traversal":
        archive.writestr("../escaped.txt", "must never escape\\n")
    else:
        link = zipfile.ZipInfo("contribute-to-eliza/unsafe-link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(link, "/tmp/unsafe-target")
`,
          maliciousArchive,
          mode,
        ],
        { stdio: "inherit" },
      );
      writeFileSync(
        `${maliciousArchive}.sha256`,
        `${sha256(readFileSync(maliciousArchive))}  contribute-to-eliza.skill\n`,
      );
      return installCommand().replaceAll(
        pathToFileURL(publicRoot).href.replace(/\/$/, ""),
        pathToFileURL(maliciousPublic).href.replace(/\/$/, ""),
      );
    }

    try {
      const traversal = runInstall(
        maliciousCommand(traversalRoot, "traversal"),
        traversalRoot,
      );
      expect(traversal.status).not.toBe(0);
      expect(existsSync(join(traversalRoot, "escaped.txt"))).toBe(false);
      expect(
        existsSync(
          join(traversalRoot, "codex", "skills", "contribute-to-eliza"),
        ),
      ).toBe(false);

      const symlinkArchive = runInstall(
        maliciousCommand(symlinkArchiveRoot, "symlink"),
        symlinkArchiveRoot,
      );
      expect(symlinkArchive.status).not.toBe(0);
      expect(
        existsSync(
          join(symlinkArchiveRoot, "codex", "skills", "contribute-to-eliza"),
        ),
      ).toBe(false);

      const brokenTarget = join(
        brokenTargetRoot,
        "codex",
        "skills",
        "contribute-to-eliza",
      );
      mkdirSync(join(brokenTargetRoot, "codex", "skills"), {
        recursive: true,
      });
      symlinkSync("missing-local-skill", brokenTarget);
      const broken = runInstall(installCommand(), brokenTargetRoot);
      expect(broken.status).not.toBe(0);
      expect(broken.stderr).toContain("Refusing to overwrite existing skill");
      expect(lstatSync(brokenTarget).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(traversalRoot, { force: true, recursive: true });
      rmSync(symlinkArchiveRoot, { force: true, recursive: true });
      rmSync(brokenTargetRoot, { force: true, recursive: true });
    }
  });

  it("rejects a forged archive whose headers underreport a 20 MB entry", () => {
    const forgedRoot = mkdtempSync(
      join(tmpdir(), "eliza-skill-install-forged-size-"),
    );
    const forgedPublic = join(forgedRoot, "public");
    const forgedDownloads = join(forgedPublic, "downloads");
    const forgedArchive = join(forgedDownloads, "contribute-to-eliza.skill");
    try {
      mkdirSync(forgedDownloads, { recursive: true });
      execFileSync(
        "python3",
        [
          "-c",
          `
import binascii
import hashlib
import json
import struct
import sys
import zipfile

archive_path = sys.argv[1]
bomb_name = "contribute-to-eliza/forged-actual-size.bin"
skill = b"---\\nname: contribute-to-eliza\\ndescription: fixture\\n---\\n"
bomb = b"A" * 20_000_000
bomb_prefix = bomb[:100]
provenance = (
    json.dumps(
        {
            "schemaVersion": "1",
            "name": "contribute-to-eliza",
            "repository": "elizaOS/eliza",
            "revision": None,
            "revisionStatus": "working-tree",
            "source": {
                "path": "packages/skills/skills/contribute-to-eliza/SKILL.md",
                "sha256": hashlib.sha256(skill).hexdigest(),
            },
            "files": [
                {
                    "path": "SKILL.md",
                    "sha256": hashlib.sha256(skill).hexdigest(),
                },
                {
                    "path": "forged-actual-size.bin",
                    "sha256": hashlib.sha256(bomb_prefix).hexdigest(),
                },
            ],
        },
        indent=2,
    )
    + "\\n"
).encode()
with zipfile.ZipFile(
    archive_path,
    "w",
    compression=zipfile.ZIP_DEFLATED,
    compresslevel=9,
) as archive:
    archive.writestr("contribute-to-eliza/SKILL.md", skill)
    archive.writestr("contribute-to-eliza/PROVENANCE.json", provenance)
    archive.writestr(bomb_name, bomb)

payload = bytearray(open(archive_path, "rb").read())
encoded_name = bomb_name.encode()
local_name_offset = payload.find(encoded_name)
central_name_offset = payload.find(encoded_name, local_name_offset + len(encoded_name))
if local_name_offset < 0 or central_name_offset < 0:
    raise RuntimeError("bomb entry headers were not found")
local_header = payload.rfind(b"PK\\x03\\x04", 0, local_name_offset)
central_header = payload.rfind(b"PK\\x01\\x02", 0, central_name_offset)
if local_header < 0 or central_header < 0:
    raise RuntimeError("bomb entry header signatures were not found")
prefix_crc = binascii.crc32(bomb_prefix) & 0xFFFFFFFF
struct.pack_into("<I", payload, local_header + 14, prefix_crc)
struct.pack_into("<I", payload, central_header + 16, prefix_crc)
struct.pack_into("<I", payload, local_header + 22, 100)
struct.pack_into("<I", payload, central_header + 24, 100)
open(archive_path, "wb").write(payload)
with zipfile.ZipFile(archive_path, "r") as archive:
    if archive.read(bomb_name) != bomb_prefix:
        raise RuntimeError("forged archive did not exercise the prefix-acceptance path")
`,
          forgedArchive,
        ],
        { stdio: "inherit" },
      );
      const forgedPayload = readFileSync(forgedArchive);
      expect(forgedPayload.length).toBeLessThan(30_000);
      writeFileSync(
        `${forgedArchive}.sha256`,
        `${sha256(forgedPayload)}  contribute-to-eliza.skill\n`,
      );
      const command = installCommand().replaceAll(
        pathToFileURL(publicRoot).href.replace(/\/$/, ""),
        pathToFileURL(forgedPublic).href.replace(/\/$/, ""),
      );
      const result = runInstall(command, forgedRoot);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Archive failed bounded integrity and path checks.",
      );
      expect(
        existsSync(join(forgedRoot, "codex", "skills", "contribute-to-eliza")),
      ).toBe(false);
    } finally {
      rmSync(forgedRoot, { force: true, recursive: true });
    }
  });
});
