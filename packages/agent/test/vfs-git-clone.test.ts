import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import git from "isomorphic-git";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createVfsGitService } from "../src/services/vfs-git.ts";
import { VirtualFilesystemService } from "../src/services/virtual-filesystem.ts";

const requests: Array<string | undefined> = [];
let directory: string;
let remote: http.Server;
let base: string;
let project = 0;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "eliza-git-clone-"));
  // A remote with no repository behind it, like a mistyped or private URL.
  remote = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(404);
    response.end("Repository not found");
  });
  await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(remote.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (remote?.listening) {
    await new Promise<void>((resolve, reject) =>
      remote.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function openProject() {
  const vfs = new VirtualFilesystemService({
    projectId: `clone-${project++}`,
    stateDir: directory,
  });
  await vfs.initialize();
  return { vfs, service: createVfsGitService(vfs) };
}

async function projectWithLocalCommit() {
  const { vfs, service } = await openProject();
  await service.run({ action: "init" });
  await vfs.writeFile("src/index.ts", "export const version = 1;\n");
  await service.run({ action: "add", paths: ["src/index.ts"] });
  const { oid } = (await service.run({
    action: "commit",
    message: "Local work",
  })) as { oid: string };
  return { vfs, service, oid };
}

it.each([
  ["a repository with local commits", false],
  ["a repository whose origin is another URL", true],
])(
  "refuses to clone over %s and keeps its history",
  async (_name, withOrigin) => {
    const { vfs, service, oid } = await projectWithLocalCommit();
    if (withOrigin) {
      await git.addRemote({
        fs,
        dir: vfs.filesRoot,
        remote: "origin",
        url: `${base}/mine.git`,
      });
    }
    requests.length = 0;

    const failure = await service
      .run({ action: "clone", url: `${base}/other.git` })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(fs.existsSync(path.join(vfs.filesRoot, ".git"))).toBe(true);
    expect(await git.resolveRef({ fs, dir: vfs.filesRoot, ref: "HEAD" })).toBe(
      oid,
    );
    await expect(service.run({ action: "log" })).resolves.toMatchObject({
      commits: [{ oid, message: "Local work\n" }],
    });
    expect(await vfs.readFile("src/index.ts")).toBe(
      "export const version = 1;\n",
    );
    expect(failure).toMatchObject({
      name: "VfsGitError",
      code: "REPOSITORY_EXISTS",
    });
    expect(requests).toEqual([]);
  },
);

it("still clones into a project without a repository", async () => {
  const { vfs, service } = await openProject();
  requests.length = 0;

  await expect(
    service.run({ action: "clone", url: `${base}/missing.git` }),
  ).rejects.toMatchObject({ code: "HttpError", data: { statusCode: 404 } });

  expect(requests.length).toBeGreaterThan(0);
  expect(fs.existsSync(path.join(vfs.filesRoot, ".git"))).toBe(false);
});
