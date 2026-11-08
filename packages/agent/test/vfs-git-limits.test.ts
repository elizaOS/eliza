/**
 * VFS Git network limits against a local smart-HTTP server (git http-backend):
 * transfers over the project's free quota fail and leave the project as it
 * was, a stalled remote times out and releases the project lock, and URLs
 * with embedded credentials are rejected.
 */
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PostWorkbenchVfsGitRequestSchema } from "@elizaos/contracts";
import git from "isomorphic-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVfsGitService } from "../src/services/vfs-git.ts";
import { VirtualFilesystemService } from "../src/services/virtual-filesystem.ts";

const gitEnv = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
let directory: string;
let gitServer: http.Server;
let stallServer: http.Server;
let project = 0;

function hostGit(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, env: gitEnv, stdio: "ignore" });
}

async function makeBareRepo(name: string, files: Record<string, Buffer>) {
  const work = path.join(directory, `${name}-work`);
  await fsp.mkdir(work);
  hostGit(work, "init", "-q", "-b", "main");
  for (const [file, bytes] of Object.entries(files)) {
    await fsp.writeFile(path.join(work, file), bytes);
  }
  hostGit(work, "add", ".");
  hostGit(
    work,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.local",
    "commit",
    "-q",
    "-m",
    "fixture",
  );
  hostGit(directory, "clone", "-q", "--bare", work, `repos/${name}.git`);
}

/** Minimal CGI bridge to git http-backend; buffers each response. */
function serveRepos(root: string): http.RequestListener {
  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const child = spawn("git", ["http-backend"], {
      env: {
        ...gitEnv,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method ?? "GET",
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
        HTTP_GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    request.pipe(child.stdin);
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("close", () => {
      const output = Buffer.concat(chunks);
      const split = output.indexOf("\r\n\r\n");
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of output.subarray(0, split).toString().split("\r\n")) {
        const colon = line.indexOf(":");
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status")
          status = Number.parseInt(value, 10);
        else headers[name] = value;
      }
      response.writeHead(status, headers);
      response.end(output.subarray(split + 4));
    });
  };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    ),
  );
}

let repoBase: string;
let stallUrl: string;

beforeAll(async () => {
  directory = await fsp.mkdtemp(path.join(os.tmpdir(), "eliza-git-limits-"));
  await fsp.mkdir(path.join(directory, "repos"));
  await makeBareRepo("small", { "README.md": Buffer.from("small repo\n") });
  // Random bytes do not compress, so the pack is at least this large.
  await makeBareRepo("large", { "blob.bin": crypto.randomBytes(400_000) });
  gitServer = http.createServer(serveRepos(path.join(directory, "repos")));
  repoBase = `http://127.0.0.1:${await listen(gitServer)}`;
  // Accepts every request and never answers.
  stallServer = http.createServer(() => {});
  stallUrl = `http://127.0.0.1:${await listen(stallServer)}/repo.git`;
});

afterAll(async () => {
  for (const server of [gitServer, stallServer]) {
    if (!server?.listening) continue;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (directory) await fsp.rm(directory, { recursive: true, force: true });
});

async function newProject(quotaBytes?: number) {
  const vfs = new VirtualFilesystemService({
    projectId: `limits-${project++}`,
    stateDir: directory,
    ...(quotaBytes ? { quotaBytes } : {}),
  });
  await vfs.initialize();
  return vfs;
}

async function projectState(vfs: VirtualFilesystemService) {
  return (await vfs.exportFiles()).map((file) => ({
    path: file.path,
    hash: crypto.createHash("sha256").update(file.bytes).digest("hex"),
  }));
}

async function stagingLeftovers(vfs: VirtualFilesystemService) {
  return (await fsp.readdir(vfs.projectRoot)).filter((name) =>
    name.startsWith(".git-stage-"),
  );
}

describe("VFS Git transfer limits", () => {
  it("clones a repository that fits the quota", async () => {
    const vfs = await newProject();
    const result = await createVfsGitService(vfs).run({
      action: "clone",
      url: `${repoBase}/small.git`,
    });

    expect(result).toMatchObject({ action: "clone", branch: "main" });
    expect(await vfs.readFile("README.md")).toBe("small repo\n");
    expect(await stagingLeftovers(vfs)).toEqual([]);
  });

  it("stops a clone larger than the quota and leaves the project empty", async () => {
    const vfs = await newProject(128 * 1024);

    await expect(
      createVfsGitService(vfs).run({
        action: "clone",
        url: `${repoBase}/large.git`,
      }),
    ).rejects.toMatchObject({
      name: "VfsGitError",
      code: "QUOTA_EXCEEDED",
    });
    expect(await vfs.list("/")).toEqual([]);
    expect(await stagingLeftovers(vfs)).toEqual([]);
  });

  it("stops a fetch larger than the free quota and leaves the project unchanged", async () => {
    const vfs = await newProject(128 * 1024);
    const service = createVfsGitService(vfs);
    await service.run({ action: "clone", url: `${repoBase}/small.git` });
    await vfs.writeFile("notes.txt", "local work\n");
    await vfs.withProjectOperation(() =>
      git.setConfig({
        fs,
        dir: vfs.filesRoot,
        path: "remote.origin.url",
        value: `${repoBase}/large.git`,
      }),
    );
    const before = await projectState(vfs);

    await expect(
      service.run({ action: "fetch", remote: "origin" }),
    ).rejects.toMatchObject({
      name: "VfsGitError",
      code: "QUOTA_EXCEEDED",
    });
    expect(await projectState(vfs)).toEqual(before);
    expect(await stagingLeftovers(vfs)).toEqual([]);
  });

  it("times out a stalled remote and releases the project lock", async () => {
    const vfs = await newProject();
    const service = createVfsGitService(vfs, { idleTimeoutMs: 200 });
    await service.run({ action: "init" });
    await vfs.withProjectOperation(() =>
      git.setConfig({
        fs,
        dir: vfs.filesRoot,
        path: "remote.origin.url",
        value: stallUrl,
      }),
    );
    const started = Date.now();

    const fetch = service.run({ action: "fetch", remote: "origin" });
    const write = vfs.writeFile("after.txt", "written");
    await expect(fetch).rejects.toMatchObject({ code: "GIT_TIMEOUT" });
    await expect(write).resolves.toMatchObject({ path: "/after.txt" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await stagingLeftovers(vfs)).toEqual([]);
  });

  it("enforces the overall deadline", async () => {
    const vfs = await newProject();
    const service = createVfsGitService(vfs, {
      timeoutMs: 200,
      idleTimeoutMs: 60_000,
    });

    await expect(
      service.run({ action: "clone", url: stallUrl }),
    ).rejects.toMatchObject({ code: "GIT_TIMEOUT" });
    expect(await vfs.list("/")).toEqual([]);
    expect(await stagingLeftovers(vfs)).toEqual([]);
  });
});

describe("VFS Git credentials in URLs", () => {
  const url = "https://user:secret@example.invalid/repo.git";

  it("rejects a clone URL with a username and password", async () => {
    const vfs = await newProject();

    await expect(
      createVfsGitService(vfs).run({ action: "clone", url }),
    ).rejects.toMatchObject({ code: "INVALID_GIT_URL" });
  });

  it("rejects the URL in the request contract", () => {
    const parsed = PostWorkbenchVfsGitRequestSchema.safeParse({
      action: "clone",
      url,
    });

    expect(parsed.success).toBe(false);
    expect(
      PostWorkbenchVfsGitRequestSchema.safeParse({
        action: "clone",
        url: "https://example.invalid/repo.git",
      }).success,
    ).toBe(true);
  });

  it("strips remote credentials from an exported .git/config", async () => {
    const vfs = await newProject();
    await vfs.writeFile(".git/config", `[remote "origin"]\n\turl = ${url}\n`);

    const config = (await vfs.exportFiles()).find(
      (file) => file.path === "/.git/config",
    );

    expect(config?.bytes.toString()).toBe(
      '[remote "origin"]\n\turl = https://example.invalid/repo.git\n',
    );
    expect(config?.size).toBe(config?.bytes.byteLength);
  });
});
