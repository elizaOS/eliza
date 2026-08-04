/**
 * Production-service journey over disposable boundaries: a real GitHub PAT
 * client creates a fixture issue over HTTP, real git creates/commits/pushes the
 * issue branch, and the production GitHub provider opens the pull request over
 * HTTP. Only GitHub itself and the repository host are local fixtures.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import type {
  GitHubPatClient as GitHubPatClientInstance,
  PullRequestInfo,
} from "git-workspace-service";
import { afterEach, describe, expect, it } from "vitest";
import { commit, push } from "../services/workspace-git-ops.js";
import {
  createIssue,
  type GitHubContext,
  type GitHubRequest,
} from "../services/workspace-github.js";
import { createGitHubPatProvider } from "../services/workspace-service.js";

const { GitHubPatClient } = createRequire(import.meta.url)(
  "git-workspace-service",
) as typeof import("git-workspace-service");

const cleanup: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function githubContext(client: GitHubPatClientInstance): GitHubContext {
  return {
    runtime: { getSetting: () => undefined } as unknown as IAgentRuntime,
    githubClient: client,
    setGithubClient() {},
    githubRequest: null,
    setGithubRequest(_request: GitHubRequest) {},
    githubAuthInProgress: null,
    setGithubAuthInProgress() {},
    authPromptCallback: null,
    log() {},
  };
}

class FixtureGitHub {
  private server: Server | undefined;
  baseUrl = "";
  requests: Array<{ method: string; path: string; body: unknown }> = [];

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        const path = req.url ?? "";
        this.requests.push({ method: req.method ?? "", path, body });
        res.setHeader("Content-Type", "application/json");
        if (req.method === "POST" && path === "/repos/acme/fixture/issues") {
          res.statusCode = 201;
          res.end(
            JSON.stringify({
              number: 41,
              html_url: "https://github.test/acme/fixture/issues/41",
              state: "open",
              title: body.title,
              body: body.body ?? "",
              labels: [],
              assignees: [],
              created_at: "2026-08-03T00:00:00Z",
              closed_at: null,
            }),
          );
          return;
        }
        if (req.method === "POST" && path === "/repos/acme/fixture/pulls") {
          res.statusCode = 201;
          res.end(
            JSON.stringify({
              number: 42,
              html_url: "https://github.test/acme/fixture/pull/42",
              state: "open",
              title: body.title,
              head: { ref: body.head },
              base: { ref: body.base },
              created_at: "2026-08-03T00:01:00Z",
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ message: "Not Found" }));
      });
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("fixture GitHub failed to bind");
    }
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("code-agent issue to pull-request journey", () => {
  it("turns a fixture issue into a pushed branch, commit, and real PR request", async () => {
    const github = new FixtureGitHub();
    await github.start();
    try {
      const client = new GitHubPatClient({
        token: "fixture-token",
        baseUrl: github.baseUrl,
      });
      const issue = await createIssue(githubContext(client), "acme/fixture", {
        title: "Fix greeting",
        body: "Change the fixture greeting and open a PR.",
      });
      expect(issue.number).toBe(41);

      const bare = tempDir("code-agent-origin-");
      execFileSync("git", ["init", "--bare", "-q", "-b", "develop", bare]);
      const work = tempDir("code-agent-work-");
      execFileSync("git", ["clone", "-q", bare, work]);
      git(work, "config", "user.email", "agent@fixture.local");
      git(work, "config", "user.name", "Fixture Agent");
      writeFileSync(join(work, "greeting.txt"), "hello\n");
      git(work, "add", "greeting.txt");
      git(work, "commit", "-q", "-m", "seed fixture");
      git(work, "push", "-q", "-u", "origin", "develop");

      const branch = `fix/issue-${issue.number}`;
      git(work, "checkout", "-q", "-b", branch);
      writeFileSync(join(work, "greeting.txt"), "hello from the code agent\n");
      const commitHash = await commit(
        work,
        { message: `fix: resolve #${issue.number}`, all: true },
        () => {},
      );
      await push(work, branch, { setUpstream: true }, () => {});
      expect(git(bare, "rev-parse", `refs/heads/${branch}`)).toBe(commitHash);

      const provider = createGitHubPatProvider({
        createClient: () => client,
      });
      const pullRequest = (await provider.createPullRequest({
        repo: "https://github.com/acme/fixture.git",
        sourceBranch: branch,
        targetBranch: "develop",
        title: `fix: resolve #${issue.number}`,
        body: `Closes #${issue.number}`,
        credential: {
          id: "fixture-grant",
          type: "pat",
          token: "fixture-token",
          repo: "https://github.com/acme/fixture.git",
          permissions: ["contents:write", "pull_requests:write"],
          expiresAt: new Date(Date.now() + 60_000),
          provider: "github",
        },
      })) as PullRequestInfo;

      expect(pullRequest).toMatchObject({
        number: 42,
        sourceBranch: branch,
        targetBranch: "develop",
      });
      expect(
        github.requests.map(({ method, path }) => `${method} ${path}`),
      ).toEqual([
        "POST /repos/acme/fixture/issues",
        "POST /repos/acme/fixture/pulls",
      ]);
    } finally {
      await github.stop();
    }
  });
});
