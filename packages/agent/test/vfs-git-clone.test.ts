import { spawn } from "node:child_process";
import fs from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import git from "isomorphic-git";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createVfsGitService } from "../src/services/vfs-git.ts";
import { VirtualFilesystemService } from "../src/services/virtual-filesystem.ts";

const requests: Array<string | undefined> = [];
const sources = new Map<string, string>();
let directory: string;
let remote: http.Server;
let base: string;
let project = 0;

async function createSource(
  name: string,
  files: Record<string, string>,
  links: Record<string, string> = {},
) {
  const dir = path.join(directory, "remote", name);
  await git.init({ fs, dir, defaultBranch: "main" });
  for (const [filepath, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, filepath)), { recursive: true });
    await writeFile(path.join(dir, filepath), content);
  }
  for (const [filepath, target] of Object.entries(links)) {
    await symlink(target, path.join(dir, filepath));
  }
  await git.add({ fs, dir, filepath: "." });
  await git.commit({
    fs,
    dir,
    message: "Initial",
    author: { name: "Remote", email: "remote@example.com" },
  });
  sources.set(name, dir);
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "eliza-git-clone-"));
  await createSource(
    "with-symlink",
    { "README.md": "# Linked\n", "docs/guide.md": "# Guide\n" },
    { "latest.md": "README.md" },
  );
  await createSource("plain", { "src/index.ts": "export const remote = 1;\n" });
  // Serves the sources over smart HTTP through git upload-pack, like a Git
  // host. Any other URL has no repository behind it, like a mistyped or
  // private URL.
  remote = http.createServer((request, response) => {
    requests.push(request.url);
    const [, name, endpoint] =
      /^\/([\w-]+)\.git\/(info\/refs\?service=git-upload-pack|git-upload-pack)$/.exec(
        request.url ?? "",
      ) ?? [];
    const source = name ? sources.get(name) : undefined;
    if (!source) {
      response.writeHead(404);
      response.end("Repository not found");
      return;
    }
    const advertise = endpoint !== "git-upload-pack";
    response.writeHead(200, {
      "content-type": `application/x-git-upload-pack-${advertise ? "advertisement" : "result"}`,
    });
    if (advertise) response.write("001e# service=git-upload-pack\n0000");
    const pack = spawn("git", [
      "upload-pack",
      "--stateless-rpc",
      ...(advertise ? ["--advertise-refs"] : []),
      source,
    ]);
    request.pipe(pack.stdin);
    pack.stdout.pipe(response);
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

async function listTree(root: string, dir = ""): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(path.join(root, dir), {
    withFileTypes: true,
  })) {
    const relative = path.posix.join(dir, entry.name);
    paths.push(relative);
    if (entry.isDirectory() && entry.name !== ".git") {
      paths.push(...(await listTree(root, relative)));
    }
  }
  return paths.sort();
}

it("leaves nothing behind when a clone is rejected for symlinks", async () => {
  const { vfs, service } = await openProject();

  await expect(
    service.run({ action: "clone", url: `${base}/with-symlink.git` }),
  ).rejects.toMatchObject({ name: "VfsGitError", code: "SYMLINK_DENIED" });

  expect(await listTree(vfs.filesRoot)).toEqual([]);
  await expect(
    service.run({ action: "clone", url: `${base}/plain.git` }),
  ).resolves.toMatchObject({ action: "clone", branch: "main" });
  expect(await listTree(vfs.filesRoot)).toEqual([
    ".git",
    "src",
    "src/index.ts",
  ]);
  expect(await vfs.readFile("src/index.ts")).toBe("export const remote = 1;\n");
});

it("keeps the project's own files when a clone is rejected for symlinks", async () => {
  const { vfs, service } = await openProject();
  await vfs.writeFile("notes.txt", "mine\n");
  await vfs.writeFile("docs/mine.md", "# Mine\n");

  await expect(
    service.run({ action: "clone", url: `${base}/with-symlink.git` }),
  ).rejects.toMatchObject({ name: "VfsGitError", code: "SYMLINK_DENIED" });

  expect(await listTree(vfs.filesRoot)).toEqual([
    "docs",
    "docs/mine.md",
    "notes.txt",
  ]);
  expect(await vfs.readFile("notes.txt")).toBe("mine\n");
  expect(await vfs.readFile("docs/mine.md")).toBe("# Mine\n");
});
