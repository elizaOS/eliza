// Pins the fail-closed error policy of the bootstrap/workspace-sync SSH helpers
// (#13415). These run during container provisioning: a failed remote SSH write
// (mkdir/rm/cat over the volume) or a corrupt bootstrap file MUST surface so the
// caller (client.ts createContainer) aborts, never read as "bootstrap succeeded".
// A legitimately-absent source (no bootstrapSource, empty file list, empty volume
// on a 200 export) is a designed-empty result and must stay distinct from a
// transport/validation failure. The harness is a deterministic in-memory fake of
// the two DockerSSHClient methods the module calls (exec/execStdin); no real SSH.
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { DockerSSHClient } from "../../docker-ssh";
import {
  decodeBootstrapFile,
  deleteWorkspaceFiles,
  exportWorkspaceFiles,
  hydrateBootstrapSource,
} from "./bootstrap";
import type { ContainerBootstrapFile } from "./types";
import { HetznerClientError } from "./types";

function fakeSsh(overrides: Partial<Record<"exec" | "execStdin", DockerSSHClient["exec"]>> = {}) {
  const exec = overrides.exec ?? mock(async () => "");
  const execStdin = overrides.execStdin ?? mock(async () => "");
  return { ssh: { exec, execStdin } as unknown as DockerSSHClient, exec, execStdin };
}

function b64File(pathName: string, contents: string): ContainerBootstrapFile {
  return {
    path: pathName,
    contents: Buffer.from(contents, "utf8").toString("base64"),
    encoding: "base64",
  };
}

describe("hydrateBootstrapSource — designed-empty vs failure", () => {
  it("returns null (designed-empty) with NO ssh call when there is no source", async () => {
    const { ssh, exec, execStdin } = fakeSsh();
    await expect(hydrateBootstrapSource(ssh, "/data", undefined)).resolves.toBeNull();
    expect(exec).not.toHaveBeenCalled();
    expect(execStdin).not.toHaveBeenCalled();
  });

  it("returns null (designed-empty) when the source carries zero files", async () => {
    const { ssh, exec } = fakeSsh();
    await expect(hydrateBootstrapSource(ssh, "/data", { files: [] })).resolves.toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });

  it("PROPAGATES an SSH transport failure on the volume-clear step (not swallowed to null)", async () => {
    // The very first exec (mkdir + clear volume) rejects: a real node was
    // unreachable. This must surface, distinct from the null designed-empty above.
    const exec = mock(async () => {
      throw new Error("[docker-ssh] exec error on node-1: connection reset");
    });
    const { ssh } = fakeSsh({ exec });
    await expect(
      hydrateBootstrapSource(ssh, "/data", { files: [b64File("a.txt", "hi")] }),
    ).rejects.toThrow(/connection reset/);
  });

  it("PROPAGATES an SSH failure while streaming a decoded file (not a fabricated success)", async () => {
    const exec = mock(async () => "");
    const execStdin = mock(async () => {
      throw new Error("[docker-ssh] exec error on node-1: broken pipe");
    });
    const { ssh } = fakeSsh({ exec, execStdin });
    await expect(
      hydrateBootstrapSource(ssh, "/data", { files: [b64File("a.txt", "hi")] }),
    ).rejects.toThrow(/broken pipe/);
  });

  it("writes the files and manifest, returning a real count on success", async () => {
    const { ssh, exec, execStdin } = fakeSsh();
    const result = await hydrateBootstrapSource(ssh, "/data", {
      files: [b64File("a.txt", "hello"), b64File("dir/b.txt", "world")],
    });
    expect(result).toEqual({ fileCount: 2, totalBytes: 10 });
    expect(exec).toHaveBeenCalled();
    expect(execStdin).toHaveBeenCalled();
  });
});

describe("decodeBootstrapFile — fail-closed validation, no fake-valid default", () => {
  it("throws invalid_input on a sha256 mismatch instead of returning corrupt bytes", () => {
    const file: ContainerBootstrapFile = {
      path: "a.txt",
      contents: Buffer.from("hello", "utf8").toString("base64"),
      encoding: "base64",
      sha256: "0".repeat(64),
    };
    expect(() => decodeBootstrapFile(file)).toThrow(HetznerClientError);
    expect(() => decodeBootstrapFile(file)).toThrow(/sha256 mismatch/);
  });

  it("throws invalid_input on a declared-size mismatch", () => {
    const file: ContainerBootstrapFile = {
      path: "a.txt",
      contents: Buffer.from("hello", "utf8").toString("base64"),
      encoding: "base64",
      size: 999,
    };
    expect(() => decodeBootstrapFile(file)).toThrow(/size mismatch/);
  });

  it("returns the exact bytes for a valid file", () => {
    expect(decodeBootstrapFile(b64File("a.txt", "hello")).toString("utf8")).toBe("hello");
  });
});

describe("exportWorkspaceFiles — empty volume vs transport failure", () => {
  it("returns an empty list for a genuinely-empty volume (200 with no output)", async () => {
    const { ssh } = fakeSsh({ exec: mock(async () => "") });
    await expect(exportWorkspaceFiles(ssh, "/data")).resolves.toEqual([]);
  });

  it("PROPAGATES an SSH failure rather than reading it as an empty workspace", async () => {
    const exec = mock(async () => {
      throw new Error("[docker-ssh] exec error on node-1: command timed out");
    });
    const { ssh } = fakeSsh({ exec });
    await expect(exportWorkspaceFiles(ssh, "/data")).rejects.toThrow(/timed out/);
  });
});

describe("deleteWorkspaceFiles — failure surfaces", () => {
  beforeEach(() => {});
  it("PROPAGATES an SSH rm failure (a failed delete must not read as success)", async () => {
    const exec = mock(async () => {
      throw new Error("[docker-ssh] exec error on node-1: permission denied");
    });
    const { ssh } = fakeSsh({ exec });
    await expect(deleteWorkspaceFiles(ssh, "/data", [{ path: "a.txt" }])).rejects.toThrow(
      /permission denied/,
    );
  });
});
