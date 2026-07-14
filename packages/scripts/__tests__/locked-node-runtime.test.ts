/**
 * Exercises both content-pinned Linux Node.js packaging boundaries with real
 * xz/tar extraction, process execution, transactional cleanup, and adversarial paths.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOCKED_NODE_ARTIFACTS,
  LOCKED_NODE_SOURCE,
  LOCKED_NODE_VERSION,
  selectLockedNodeArtifact,
  testing,
} from "../locked-node-runtime.mjs";

const roots: string[] = [];
const artifactCases = [
  {
    platform: "linux-x64",
    architecture: "x64",
    archive: {
      name: "node-v24.15.0-linux-x64.tar.xz",
      rootDirectory: "node-v24.15.0-linux-x64",
      url: "https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-x64.tar.xz",
      size: 31_164_460,
      sha256:
        "472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6",
    },
    executable: {
      path: "bin/node",
      size: 122_889_056,
      sha256:
        "d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c",
    },
  },
  {
    platform: "linux-arm64",
    architecture: "arm64",
    archive: {
      name: "node-v24.15.0-linux-arm64.tar.xz",
      rootDirectory: "node-v24.15.0-linux-arm64",
      url: "https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-arm64.tar.xz",
      size: 30_108_656,
      sha256:
        "f3d5a797b5d210ce8e2cb265544c8e482eaedcb8aa409a8b46da7e8595d0dda0",
    },
    executable: {
      path: "bin/node",
      size: 120_702_160,
      sha256:
        "d0b9f94a9771bba3c30a54f0aee622fa0bee37be684cc1df6da2d3448606d98d",
    },
  },
] as const;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "eliza-locked-node-")));
  roots.push(root);
  return root;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function createFixtureArchive(
  lockedArtifact: (typeof LOCKED_NODE_ARTIFACTS)[keyof typeof LOCKED_NODE_ARTIFACTS],
  options?: {
    license?: boolean;
    version?: string;
    escapingSymlink?: boolean;
  },
) {
  const root = temporaryRoot();
  const sourceParent = join(root, "source");
  const packageRoot = join(sourceParent, lockedArtifact.archive.rootDirectory);
  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  const nodePath = join(packageRoot, "bin", "node");
  writeFileSync(
    nodePath,
    `#!/bin/sh\n# ${lockedArtifact.architecture}\nprintf '%s\\n' '${options?.version ?? `v${LOCKED_NODE_VERSION}`}'\n`,
  );
  chmodSync(nodePath, 0o755);
  if (options?.license !== false) {
    writeFileSync(join(packageRoot, "LICENSE"), "fixture Node.js license\n");
  }
  if (options?.escapingSymlink) {
    symlinkSync("../../../outside", join(packageRoot, "bin", "escape"));
  } else {
    symlinkSync("node", join(packageRoot, "bin", "node-link"));
  }
  const archivePath = join(root, lockedArtifact.archive.name);
  const result = spawnSync(
    "tar",
    [
      "--create",
      "--xz",
      "--file",
      archivePath,
      "--directory",
      sourceParent,
      lockedArtifact.archive.rootDirectory,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`Could not create fixture archive: ${result.stderr}`);
  }

  const artifact = {
    ...lockedArtifact,
    archive: {
      ...lockedArtifact.archive,
      url: `fixture://node-${lockedArtifact.architecture}.tar.xz`,
      size: lstatSync(archivePath).size,
      sha256: sha256(archivePath),
    },
    executable: {
      path: "bin/node",
      size: lstatSync(nodePath).size,
      sha256: sha256(nodePath),
    },
  };
  const downloadRequests: Array<{ url: string; maximumSize: number }> = [];
  return {
    root,
    archivePath,
    artifact,
    downloadRequests,
    downloadFile(url: string, destination: string, maximumSize: number) {
      downloadRequests.push({ url, maximumSize });
      copyFileSync(archivePath, destination);
    },
  };
}

function stagingEntries(parent: string): string[] {
  return readdirSync(parent).filter(
    (name) =>
      name.startsWith(".eliza-node-archive-") ||
      name.startsWith(".eliza-node-payload-"),
  );
}

describe("locked Node.js artifact selection", () => {
  it("pins both official Linux distributions and the repository toolchain", () => {
    expect(LOCKED_NODE_VERSION).toBe("24.15.0");
    expect(LOCKED_NODE_ARTIFACTS).toEqual(
      Object.fromEntries(
        artifactCases.map((artifact) => [artifact.platform, artifact]),
      ),
    );
    expect(LOCKED_NODE_SOURCE).toEqual({
      url: "https://nodejs.org/dist/v24.15.0/node-v24.15.0.tar.xz",
      sha256:
        "a4f653d79ed140aaad921e8c22a3b585ca85cfdab80d4030f6309e4663a8a1c8",
    });
    expect(() => testing.assertRepositoryNodePin()).not.toThrow();
  });

  it.each(
    artifactCases,
  )("selects $platform without an architecture fallback", (expected) => {
    expect(selectLockedNodeArtifact("linux", expected.architecture)).toBe(
      LOCKED_NODE_ARTIFACTS[expected.platform],
    );
  });

  it.each([
    ["darwin", "x64"],
    ["linux", "riscv64"],
    ["linux", "amd64"],
  ])("rejects unsupported target %s/%s", (platform, architecture) => {
    expect(() => selectLockedNodeArtifact(platform, architecture)).toThrow(
      `received ${platform} ${architecture}`,
    );
  });
});

describe.each(artifactCases)("locked Node.js runtime $platform", ({
  architecture,
  platform,
}) => {
  const lockedArtifact = selectLockedNodeArtifact("linux", architecture);

  it("atomically installs a verified archive with artifact provenance", () => {
    const fixture = createFixtureArchive(lockedArtifact);
    const destination = join(fixture.root, "node-runtime");
    const result = testing.provisionVerifiedNodeRuntime({
      artifact: fixture.artifact,
      destination,
      downloadFile: fixture.downloadFile,
    });

    expect(result).toEqual({
      destination,
      version: LOCKED_NODE_VERSION,
      archiveSha256: fixture.artifact.archive.sha256,
    });
    expect(fixture.downloadRequests).toEqual([
      {
        url: fixture.artifact.archive.url,
        maximumSize: fixture.artifact.archive.size,
      },
    ]);
    expect(readFileSync(join(destination, "LICENSE"), "utf8")).toContain(
      "fixture Node.js license",
    );
    expect(
      JSON.parse(
        readFileSync(
          join(destination, "elizaos-runtime-provenance.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      sourceUrl: fixture.artifact.archive.url,
      archiveSha256: fixture.artifact.archive.sha256,
      executableSha256: fixture.artifact.executable.sha256,
      source: LOCKED_NODE_SOURCE,
      version: LOCKED_NODE_VERSION,
      platform,
    });
    expect(lstatSync(join(destination, "bin", "node")).mode & 0o111).not.toBe(
      0,
    );
    expect(stagingEntries(fixture.root)).toEqual([]);
  });

  it("preserves service-readable modes under a restrictive builder umask", () => {
    const fixture = createFixtureArchive(lockedArtifact);
    const destination = join(fixture.root, "node-runtime");
    const previousUmask = process.umask(0o077);
    try {
      testing.provisionVerifiedNodeRuntime({
        artifact: fixture.artifact,
        destination,
        downloadFile: fixture.downloadFile,
      });
    } finally {
      process.umask(previousUmask);
    }

    expect(lstatSync(destination).mode & 0o555).toBe(0o555);
    expect(lstatSync(join(destination, "LICENSE")).mode & 0o444).toBe(0o444);
    expect(
      lstatSync(join(destination, "elizaos-runtime-provenance.json")).mode &
        0o444,
    ).toBe(0o444);
  });

  it("rejects an archive hash mismatch without exposing a partial runtime", () => {
    const fixture = createFixtureArchive(lockedArtifact);
    const destination = join(fixture.root, "node-runtime");
    expect(() =>
      testing.provisionVerifiedNodeRuntime({
        artifact: {
          ...fixture.artifact,
          archive: {
            ...fixture.artifact.archive,
            sha256: "0".repeat(64),
          },
        },
        destination,
        downloadFile: fixture.downloadFile,
      }),
    ).toThrow("SHA-256 mismatch");
    expect(lstatSync(destination, { throwIfNoEntry: false })).toBeUndefined();
    expect(stagingEntries(fixture.root)).toEqual([]);
  });

  it("rejects an executable hash mismatch without exposing a partial runtime", () => {
    const fixture = createFixtureArchive(lockedArtifact);
    const destination = join(fixture.root, "node-runtime");
    expect(() =>
      testing.provisionVerifiedNodeRuntime({
        artifact: {
          ...fixture.artifact,
          executable: {
            ...fixture.artifact.executable,
            sha256: "0".repeat(64),
          },
        },
        destination,
        downloadFile: fixture.downloadFile,
      }),
    ).toThrow("does not match the locked");
    expect(lstatSync(destination, { throwIfNoEntry: false })).toBeUndefined();
    expect(stagingEntries(fixture.root)).toEqual([]);
  });

  it("rejects archive traversal and unexpected root identities", () => {
    const rootDirectory = lockedArtifact.archive.rootDirectory;
    expect(() =>
      testing.validateArchiveEntries(
        `${rootDirectory}/\n${rootDirectory}/../../escape\n`,
        rootDirectory,
      ),
    ).toThrow("Unsafe path");
    expect(() =>
      testing.validateArchiveEntries(
        "different-root/\ndifferent-root/bin/node\n",
        rootDirectory,
      ),
    ).toThrow("unexpected root");
  });

  it("rejects escaping symlinks and removes the extracted staging tree", () => {
    const fixture = createFixtureArchive(lockedArtifact, {
      escapingSymlink: true,
    });
    const destination = join(fixture.root, "node-runtime");
    expect(() =>
      testing.provisionVerifiedNodeRuntime({
        artifact: fixture.artifact,
        destination,
        downloadFile: fixture.downloadFile,
      }),
    ).toThrow("escapes the staging root");
    expect(lstatSync(destination, { throwIfNoEntry: false })).toBeUndefined();
    expect(stagingEntries(fixture.root)).toEqual([]);
  });

  it("rejects a missing license and version drift transactionally", () => {
    for (const fixture of [
      createFixtureArchive(lockedArtifact, { license: false }),
      createFixtureArchive(lockedArtifact, { version: "v24.14.0" }),
    ]) {
      const destination = join(fixture.root, "node-runtime");
      expect(() =>
        testing.provisionVerifiedNodeRuntime({
          artifact: fixture.artifact,
          destination,
          downloadFile: fixture.downloadFile,
        }),
      ).toThrow(/LICENSE|version mismatch/);
      expect(lstatSync(destination, { throwIfNoEntry: false })).toBeUndefined();
      expect(stagingEntries(fixture.root)).toEqual([]);
    }
  });

  it("never overwrites an existing file, directory, or symlink destination", () => {
    const fixture = createFixtureArchive(lockedArtifact);
    const outside = join(fixture.root, "outside");
    writeFileSync(outside, "owner data");
    const destinations = [
      join(fixture.root, "existing-file"),
      join(fixture.root, "existing-directory"),
      join(fixture.root, "existing-symlink"),
    ];
    writeFileSync(destinations[0], "owner data");
    mkdirSync(destinations[1]);
    symlinkSync(outside, destinations[2]);

    for (const destination of destinations) {
      expect(() =>
        testing.provisionVerifiedNodeRuntime({
          artifact: fixture.artifact,
          destination,
          downloadFile: fixture.downloadFile,
        }),
      ).toThrow("destination already exists");
    }
    expect(readFileSync(outside, "utf8")).toBe("owner data");
    expect(readFileSync(destinations[0], "utf8")).toBe("owner data");
    expect(stagingEntries(fixture.root)).toEqual([]);
  });
});
