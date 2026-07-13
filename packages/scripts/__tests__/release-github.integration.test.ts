/**
 * Exercises GitHub Release finalization through a real loopback HTTP boundary
 * after a real bare-Git tag push. The fixture proves create/readback, exact
 * retry, identity conflict, and HTTP failure classification without touching a
 * public repository or release.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http, { type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  buildAndPackReleaseCandidate,
  loadReleaseState,
  recordReleaseTransition,
} from "../lib/release-candidate.mjs";
import { pushReleaseTag } from "../lib/release-git.mjs";
import {
  GitHubReleaseError,
  publishGitHubRelease,
} from "../lib/release-github.mjs";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function git(repoRoot: string, args: string[]) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeTaggedCandidate() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "release-github-"));
  roots.push(base);
  const repoRoot = path.join(base, "source");
  const remotePath = path.join(base, "remote.git");
  const remote = "origin";
  fs.mkdirSync(repoRoot);
  writeJson(path.join(repoRoot, "package.json"), {
    private: true,
    workspaces: ["packages/*"],
  });
  writeJson(path.join(repoRoot, "packages/a/package.json"), {
    name: "@release-github/a",
    version: "1.0.0-beta.1",
    type: "module",
    main: "index.js",
    files: ["index.js"],
    publishConfig: { access: "public" },
  });
  fs.writeFileSync(
    path.join(repoRoot, "packages/a/index.js"),
    "export default 'release';\n",
  );
  fs.writeFileSync(path.join(repoRoot, "build.mjs"), "// Already built.\n");
  git(repoRoot, ["init", "-b", "develop"]);
  git(repoRoot, ["config", "user.name", "Release GitHub Test"]);
  git(repoRoot, ["config", "user.email", "release-github@example.test"]);
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-m", "prepared release source"]);
  const sourceSha = git(repoRoot, ["rev-parse", "HEAD"]);
  execFileSync("git", ["init", "--bare", remotePath]);
  const canonicalRemote = "https://github.com/elizaOS/eliza.git";
  git(repoRoot, [
    "config",
    `url.file://${remotePath}.insteadOf`,
    canonicalRemote,
  ]);
  git(repoRoot, ["remote", "add", remote, canonicalRemote]);
  git(repoRoot, ["push", remote, `${sourceSha}:refs/heads/develop`]);

  const candidateDirectory = path.join(base, "candidate");
  const { plan } = buildAndPackReleaseCandidate({
    repoRoot,
    outputDirectory: candidateDirectory,
    packageNames: ["@release-github/a"],
    version: "1.0.0-beta.1",
    channel: "beta",
    sourceSha,
    expectedCommit: sourceSha,
    repository: "elizaOS/eliza",
    sourceRef: "refs/heads/develop",
    registry: "https://registry.npmjs.org/",
    publisher: "release-github",
    build: { command: process.execPath, args: ["build.mjs"] },
  });
  recordReleaseTransition(candidateDirectory, "registry-bound", {
    registry: plan.registry,
    publisher: plan.publisher,
    candidateTag: plan.candidateTag,
  });
  recordReleaseTransition(candidateDirectory, "registry-staged", {
    registry: plan.registry,
    publisher: plan.publisher,
    candidateTag: plan.candidateTag,
    actions: [],
  });
  recordReleaseTransition(candidateDirectory, "registry-verified", {
    registry: plan.registry,
    packages: [],
  });
  recordReleaseTransition(candidateDirectory, "channel-promoted", {
    registry: plan.registry,
    channel: plan.channel,
    promotions: [],
    candidateTagCleanup: [],
  });
  pushReleaseTag({
    repoRoot,
    candidateDirectory,
    remote,
    tag: "v1.0.0-beta.1",
  });
  return { repoRoot, remote, sourceSha, candidateDirectory };
}

async function requestBody(request: http.IncomingMessage) {
  let source = "";
  for await (const chunk of request) source += chunk.toString();
  return JSON.parse(source) as Record<string, unknown>;
}

async function startApi({
  getStatus = 200,
  malformed = false,
  initialRelease = null,
}: {
  getStatus?: number;
  malformed?: boolean;
  initialRelease?: Record<string, unknown> | null;
} = {}) {
  let release = initialRelease;
  const posts: Record<string, unknown>[] = [];
  const server = http.createServer(async (request, response) => {
    const tagPath = "/api/repos/elizaOS/eliza/releases/tags/v1.0.0-beta.1";
    const collectionPath = "/api/repos/elizaOS/eliza/releases";
    if (request.method === "GET" && request.url === tagPath) {
      if (getStatus !== 200) {
        response.writeHead(getStatus, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "fixture failure" }));
        return;
      }
      if (release === null) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "not found" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(malformed ? "not-json" : JSON.stringify(release));
      return;
    }
    if (request.method === "POST" && request.url === collectionPath) {
      const body = await requestBody(request);
      posts.push(body);
      release = {
        id: 71,
        tag_name: body.tag_name,
        target_commitish: body.target_commitish,
        draft: body.draft,
        prerelease: body.prerelease,
        html_url: "https://github.example/elizaOS/eliza/releases/71",
      };
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify(release));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "unknown fixture route" }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to bind GitHub fixture API");
  }
  return {
    apiUrl: `http://127.0.0.1:${address.port}/api/`,
    posts,
    release: () => release,
  };
}

describe("GitHub release finalization", () => {
  test("creates after the exact tag, reads back, records, and retries without mutation", async () => {
    const fixture = makeTaggedCandidate();
    const api = await startApi();
    const created = await publishGitHubRelease({
      repoRoot: fixture.repoRoot,
      candidateDirectory: fixture.candidateDirectory,
      repository: "elizaOS/eliza",
      tag: "v1.0.0-beta.1",
      token: "fixture-token",
      apiUrl: api.apiUrl,
    });
    expect(created).toMatchObject({
      created: true,
      releaseId: 71,
      prerelease: true,
      expectedCommit: fixture.sourceSha,
    });
    expect(api.posts).toEqual([
      {
        tag_name: "v1.0.0-beta.1",
        target_commitish: fixture.sourceSha,
        name: "v1.0.0-beta.1",
        draft: false,
        prerelease: true,
        generate_release_notes: true,
      },
    ]);
    expect(loadReleaseState(fixture.candidateDirectory).state.phase).toBe(
      "release-published",
    );

    expect(
      await publishGitHubRelease({
        repoRoot: fixture.repoRoot,
        candidateDirectory: fixture.candidateDirectory,
        repository: "elizaOS/eliza",
        tag: "v1.0.0-beta.1",
        token: "fixture-token",
        apiUrl: api.apiUrl,
      }),
    ).toMatchObject({ created: false, releaseId: 71 });
    expect(api.posts).toHaveLength(1);
    expect(api.release()).not.toBeNull();
  }, 30_000);

  test("rejects an existing release with a different public identity", async () => {
    const fixture = makeTaggedCandidate();
    const api = await startApi({
      initialRelease: {
        id: 71,
        tag_name: "v1.0.0-beta.1",
        draft: false,
        prerelease: false,
        html_url: "https://github.example/elizaOS/eliza/releases/71",
      },
    });
    await expect(
      publishGitHubRelease({
        repoRoot: fixture.repoRoot,
        candidateDirectory: fixture.candidateDirectory,
        repository: "elizaOS/eliza",
        tag: "v1.0.0-beta.1",
        token: "fixture-token",
        apiUrl: api.apiUrl,
      }),
    ).rejects.toThrow("does not match the planned public identity");
    expect(api.posts).toHaveLength(0);
    expect(loadReleaseState(fixture.candidateDirectory).state.phase).toBe(
      "git-tagged",
    );
  }, 30_000);

  test("rejects a mismatched repository or release target before recording finalization", async () => {
    const fixture = makeTaggedCandidate();
    const api = await startApi({
      initialRelease: {
        id: 71,
        tag_name: "v1.0.0-beta.1",
        target_commitish: "b".repeat(40),
        draft: false,
        prerelease: true,
        html_url: "https://github.example/elizaOS/eliza/releases/71",
      },
    });
    await expect(
      publishGitHubRelease({
        repoRoot: fixture.repoRoot,
        candidateDirectory: fixture.candidateDirectory,
        repository: "other/repository",
        tag: "v1.0.0-beta.1",
        token: "fixture-token",
        apiUrl: api.apiUrl,
      }),
    ).rejects.toThrow("does not match planned elizaOS/eliza");
    await expect(
      publishGitHubRelease({
        repoRoot: fixture.repoRoot,
        candidateDirectory: fixture.candidateDirectory,
        repository: "elizaOS/eliza",
        tag: "v1.0.0-beta.1",
        token: "fixture-token",
        apiUrl: api.apiUrl,
      }),
    ).rejects.toThrow("does not match the planned public identity");
    expect(api.posts).toHaveLength(0);
    expect(loadReleaseState(fixture.candidateDirectory).state.phase).toBe(
      "git-tagged",
    );
  }, 30_000);

  test.each([
    [401, "authentication"],
    [429, "throttling"],
    [503, "server"],
  ])(
    "classifies HTTP %i and never fabricates a missing release",
    async (status, kind) => {
      const fixture = makeTaggedCandidate();
      const api = await startApi({ getStatus: status });
      try {
        await publishGitHubRelease({
          repoRoot: fixture.repoRoot,
          candidateDirectory: fixture.candidateDirectory,
          repository: "elizaOS/eliza",
          tag: "v1.0.0-beta.1",
          token: "fixture-token",
          apiUrl: api.apiUrl,
        });
        throw new Error("Expected GitHub finalization to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(GitHubReleaseError);
        expect((error as GitHubReleaseError).kind).toBe(kind);
        expect((error as GitHubReleaseError).status).toBe(status);
      }
      expect(api.posts).toHaveLength(0);
      expect(loadReleaseState(fixture.candidateDirectory).state.phase).toBe(
        "git-tagged",
      );
    },
    30_000,
  );
});
