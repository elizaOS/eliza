/**
 * HTTP-boundary tests for the GitHub issue functions in workspace-github.ts.
 * A REAL local node:http server implements the GitHub REST endpoints and a
 * REAL `GitHubPatClient` (Octokit under the hood) is pointed at it via its
 * `baseUrl` option, then injected through the production `GitHubContext`
 * client slot — so the entire request path (auth header, method, route,
 * payload serialization, response mapping) is genuinely exercised; only the
 * host on the other end of the socket is local. Error legs assert non-2xx
 * responses surface as thrown errors, never as fabricated results.
 */
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { IAgentRuntime } from "@elizaos/core";
import type { GitHubPatClient as GitHubPatClientInstance } from "git-workspace-service";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  addComment,
  addLabels,
  closeIssue,
  createIssue,
  ensureGitHubClient,
  type GitHubContext,
  type GitHubRequest,
  getPullRequestGroundTruth,
  listIssues,
  parseOwnerRepo,
  updateIssue,
} from "../services/workspace-github.ts";

const { GitHubPatClient } = createRequire(import.meta.url)(
  "git-workspace-service",
) as typeof import("git-workspace-service");

interface RecordedRequest {
  method: string;
  path: string;
  auth: string | undefined;
  body: unknown;
}

/** Minimal GitHub REST stand-in. Each handler records the request and replies
 * with a canonical GitHub issue payload so the client's field mapping runs. */
class FakeGitHub {
  server: Server | undefined;
  baseUrl = "";
  requests: RecordedRequest[] = [];
  /** When set, the next request gets this failure instead of a 2xx. */
  failNext: { status: number; message: string } | null = null;
  issueLabels = ["bug"];
  applyLabelWrites = true;

  private issueJson(overrides: Record<string, unknown> = {}) {
    return {
      number: 7,
      html_url: "http://local/acme/widgets/issues/7",
      state: "open",
      title: "Broken widget",
      body: "It broke",
      labels: this.issueLabels.map((name) => ({ name })),
      assignees: [{ login: "octocat" }],
      created_at: "2026-07-01T00:00:00Z",
      closed_at: null,
      ...overrides,
    };
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : undefined;
        const path = req.url ?? "";
        this.requests.push({
          method: req.method ?? "",
          path,
          auth: req.headers.authorization,
          body,
        });
        if (this.failNext) {
          const { status, message } = this.failNext;
          this.failNext = null;
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ message }));
          return;
        }
        res.setHeader("Content-Type", "application/json");
        if (req.method === "GET" && /\/issues(\?|$)/.test(path)) {
          res.end(
            JSON.stringify([
              this.issueJson(),
              // A PR masquerading in the issues list — the client must filter it.
              this.issueJson({ number: 8, pull_request: { url: "x" } }),
            ]),
          );
          return;
        }
        if (req.method === "GET" && /\/issues\/\d+$/.test(path)) {
          res.end(JSON.stringify(this.issueJson()));
          return;
        }
        if (req.method === "POST" && /\/issues\/\d+\/comments$/.test(path)) {
          res.statusCode = 201;
          res.end(
            JSON.stringify({
              id: 999,
              body: (body as { body?: string })?.body ?? "",
              user: { login: "octocat" },
              created_at: "2026-07-01T00:00:00Z",
              html_url: "http://local/comment/999",
            }),
          );
          return;
        }
        if (req.method === "POST" && /\/issues\/\d+\/labels$/.test(path)) {
          if (this.applyLabelWrites) {
            this.issueLabels = Array.from(
              new Set([
                ...this.issueLabels,
                ...((body as { labels?: string[] })?.labels ?? []),
              ]),
            );
          }
          res.end(JSON.stringify([{ name: "triage" }]));
          return;
        }
        if (req.method === "POST" && /\/issues$/.test(path)) {
          res.statusCode = 201;
          res.end(
            JSON.stringify(
              this.issueJson({
                title: (body as { title?: string })?.title,
                body: (body as { body?: string })?.body ?? "",
              }),
            ),
          );
          return;
        }
        if (req.method === "PATCH" && /\/issues\/\d+$/.test(path)) {
          res.end(
            JSON.stringify(
              this.issueJson({
                state: (body as { state?: string })?.state ?? "open",
                title: (body as { title?: string })?.title ?? "Broken widget",
              }),
            ),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ message: "Not Found" }));
      });
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server?.address();
    if (!address || typeof address === "string") {
      throw new Error("fake GitHub server failed to bind");
    }
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server?.close((err) => (err ? reject(err) : resolve()));
    });
  }

  lastRequest(): RecordedRequest {
    const last = this.requests.at(-1);
    if (!last) throw new Error("no request recorded");
    return last;
  }
}

function makeCtx(client: GitHubPatClientInstance | null): GitHubContext {
  const state = {
    client,
    request: null as GitHubRequest | null,
    inProgress: null as GitHubContext["githubAuthInProgress"],
  };
  return {
    runtime: {
      getSetting: () => undefined,
    } as unknown as IAgentRuntime,
    get githubClient() {
      return state.client;
    },
    setGithubClient: (c) => {
      state.client = c;
    },
    get githubRequest() {
      return state.request;
    },
    setGithubRequest: (request) => {
      state.request = request;
    },
    get githubAuthInProgress() {
      return state.inProgress;
    },
    setGithubAuthInProgress: (p) => {
      state.inProgress = p;
    },
    authPromptCallback: null,
    log: () => {},
  };
}

function makeRequestCtx(request: GitHubRequest): GitHubContext {
  const ctx = makeCtx({} as GitHubPatClientInstance);
  ctx.setGithubRequest(request);
  return ctx;
}

describe("parseOwnerRepo", () => {
  it("parses owner/repo shorthand and full GitHub URLs", () => {
    expect(parseOwnerRepo("acme/widgets")).toEqual({
      owner: "acme",
      repo: "widgets",
    });
    expect(parseOwnerRepo("https://github.com/acme/widgets")).toEqual({
      owner: "acme",
      repo: "widgets",
    });
  });

  it("throws a typed error on unparseable input", () => {
    expect(() => parseOwnerRepo("not-a-repo")).toThrow(
      /Cannot parse owner\/repo/,
    );
  });
});

describe("ensureGitHubClient", () => {
  it("fails loudly when no client, token, or OAuth client id is configured", async () => {
    await expect(ensureGitHubClient(makeCtx(null))).rejects.toThrow(
      /GitHub access required but no credentials are configured/,
    );
  });

  it("builds a PAT client late when GITHUB_TOKEN appears in settings", async () => {
    const ctx = makeCtx(null);
    (
      ctx.runtime as { getSetting: (k: string) => string | undefined }
    ).getSetting = (k: string) =>
      k === "GITHUB_TOKEN" ? "ghp_test" : undefined;
    const client = await ensureGitHubClient(ctx);
    expect(client).toBeInstanceOf(GitHubPatClient);
    // The context caches the client for subsequent calls.
    expect(await ensureGitHubClient(ctx)).toBe(client);
  });
});

describe("getPullRequestGroundTruth", () => {
  const link = {
    url: "https://github.com/elizaos/eliza/pull/16453",
    repo: "elizaos/eliza",
    number: 16453,
  };

  it("marks branch protection 403 as checks unavailable", async () => {
    const request = vi.fn(async (route: string) => {
      if (route.includes("/files")) {
        return { data: [{ filename: "src/a.ts" }] };
      }
      if (route.includes("/pulls/{pull_number}")) {
        return {
          data: {
            html_url: link.url,
            state: "open",
            merged_at: null,
            head: { sha: "abc123" },
            base: { ref: "develop" },
          },
        };
      }
      if (route.includes("/check-runs")) {
        return { data: { check_runs: [] } };
      }
      if (route.includes("/status")) {
        return { data: { statuses: [] } };
      }
      if (route.includes("/protection")) {
        throw Object.assign(new Error("Forbidden"), { status: 403 });
      }
      if (route.includes("/rules/branches")) {
        return { data: [] };
      }
      throw new Error(`unexpected route ${route}`);
    }) as GitHubRequest;

    const result = await getPullRequestGroundTruth(
      makeRequestCtx(request),
      link,
    );
    expect(result?.checksUnavailable).toBe(true);
    expect(result?.checksUnavailableReason).toContain("403");
  });

  it("preserves app_id when matching required branch-protection checks", async () => {
    const request = vi.fn(async (route: string) => {
      if (route.includes("/files")) return { data: [] };
      if (route.includes("/pulls/{pull_number}")) {
        return {
          data: {
            html_url: link.url,
            state: "open",
            merged_at: null,
            head: { sha: "abc123" },
            base: { ref: "develop" },
          },
        };
      }
      if (route.includes("/check-runs")) {
        return {
          data: {
            check_runs: [
              {
                name: "unit",
                status: "completed",
                conclusion: "success",
                app: { id: 15368 },
              },
              {
                name: "unit",
                status: "completed",
                conclusion: "success",
                app: { id: 999 },
              },
            ],
          },
        };
      }
      if (route.includes("/status")) return { data: { statuses: [] } };
      if (route.includes("/protection")) {
        return {
          data: {
            required_status_checks: {
              contexts: [],
              checks: [{ context: "unit", app_id: 15368 }],
            },
          },
        };
      }
      if (route.includes("/rules/branches")) return { data: [] };
      throw new Error(`unexpected route ${route}`);
    }) as GitHubRequest;

    const result = await getPullRequestGroundTruth(
      makeRequestCtx(request),
      link,
    );
    expect(result?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "unit", appId: 15368, required: true }),
        expect.objectContaining({ name: "unit", appId: 999, required: false }),
      ]),
    );
  });

  it("uses ruleset required checks when classic branch protection is unavailable", async () => {
    const request = vi.fn(async (route: string) => {
      if (route.includes("/files")) return { data: [] };
      if (route.includes("/pulls/{pull_number}")) {
        return {
          data: {
            html_url: link.url,
            state: "open",
            merged_at: null,
            head: { sha: "abc123" },
            base: { ref: "develop" },
          },
        };
      }
      if (route.includes("/check-runs")) {
        return {
          data: {
            check_runs: [
              {
                name: "ruleset-unit",
                status: "completed",
                conclusion: "success",
                app: { id: 15368 },
              },
            ],
          },
        };
      }
      if (route.includes("/status")) return { data: { statuses: [] } };
      if (route.includes("/protection")) {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      }
      if (route.includes("/rules/branches")) {
        return {
          data: [
            {
              type: "required_status_checks",
              parameters: {
                required_status_checks: [
                  { context: "ruleset-unit", integration_id: 15368 },
                ],
              },
            },
          ],
        };
      }
      throw new Error(`unexpected route ${route}`);
    }) as GitHubRequest;

    const result = await getPullRequestGroundTruth(
      makeRequestCtx(request),
      link,
    );
    expect(result?.checksUnavailable).not.toBe(true);
    expect(result?.checks).toContainEqual(
      expect.objectContaining({
        name: "ruleset-unit",
        appId: 15368,
        required: true,
      }),
    );
  });

  it("retries when the PR head changes while fetching files and checks", async () => {
    let pullReads = 0;
    const request = vi.fn(async (route: string) => {
      if (route.includes("/files")) return { data: [] };
      if (route.includes("/pulls/{pull_number}")) {
        pullReads += 1;
        const sha = pullReads === 1 ? "old" : "new";
        return {
          data: {
            html_url: link.url,
            state: "open",
            merged_at: null,
            head: { sha },
            base: { ref: "develop" },
          },
        };
      }
      if (route.includes("/check-runs")) {
        return {
          data: {
            check_runs: [
              {
                name: "unit",
                status: "completed",
                conclusion: "success",
                app: { id: 15368 },
              },
            ],
          },
        };
      }
      if (route.includes("/status")) return { data: { statuses: [] } };
      if (route.includes("/protection")) {
        return {
          data: {
            required_status_checks: {
              contexts: [],
              checks: [{ context: "unit", app_id: 15368 }],
            },
          },
        };
      }
      if (route.includes("/rules/branches")) return { data: [] };
      throw new Error(`unexpected route ${route}`);
    }) as GitHubRequest;

    const result = await getPullRequestGroundTruth(
      makeRequestCtx(request),
      link,
    );
    expect(result?.headSha).toBe("new");
    expect(pullReads).toBeGreaterThanOrEqual(3);
  });
});

describe("issue functions over a real local GitHub API server", () => {
  const github = new FakeGitHub();
  let ctx: GitHubContext;

  beforeAll(async () => {
    await github.start();
    ctx = makeCtx(
      new GitHubPatClient({ token: "ghp_local", baseUrl: github.baseUrl }),
    );
  });
  afterAll(async () => {
    await github.stop();
  });

  it("createIssue POSTs the exact payload with the PAT and maps the response", async () => {
    const issue = await createIssue(ctx, "acme/widgets", {
      title: "Broken widget",
      body: "It broke",
      labels: ["bug"],
    });
    const req = github.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/repos/acme/widgets/issues");
    expect(req.auth).toBe("token ghp_local");
    expect(req.body).toMatchObject({
      title: "Broken widget",
      body: "It broke",
      labels: ["bug"],
    });
    expect(issue.number).toBe(7);
    expect(issue.title).toBe("Broken widget");
    expect(issue.labels).toEqual(["bug"]);
    expect(issue.assignees).toEqual(["octocat"]);
  });

  it("updateIssue PATCHes the issue with only the provided fields", async () => {
    const issue = await updateIssue(ctx, "acme/widgets", 7, {
      title: "Renamed widget",
    });
    const req = github.lastRequest();
    expect(req.method).toBe("PATCH");
    expect(req.path).toBe("/repos/acme/widgets/issues/7");
    expect(req.body).toMatchObject({ title: "Renamed widget" });
    expect(issue.title).toBe("Renamed widget");
  });

  it("closeIssue PATCHes state=closed and returns the closed issue", async () => {
    const issue = await closeIssue(ctx, "acme/widgets", 7);
    const req = github.lastRequest();
    expect(req.method).toBe("PATCH");
    expect(req.path).toBe("/repos/acme/widgets/issues/7");
    expect(req.body).toMatchObject({ state: "closed" });
    expect(issue.state).toBe("closed");
  });

  it("addLabels proves the mutation with an authoritative issue readback", async () => {
    const before = github.requests.length;
    const issue = await addLabels(ctx, "acme/widgets", 7, ["triage", "p1"]);
    const [req, readback] = github.requests.slice(before);
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/repos/acme/widgets/issues/7/labels");
    expect(req.body).toMatchObject({ labels: ["triage", "p1"] });
    expect(readback).toMatchObject({
      method: "GET",
      path: "/repos/acme/widgets/issues/7",
    });
    expect(issue.labels).toEqual(expect.arrayContaining(["triage", "p1"]));
  });

  it("rejects label success when provider readback does not contain the requested label", async () => {
    github.applyLabelWrites = false;
    await expect(
      addLabels(ctx, "acme/widgets", 7, ["not-observed"]),
    ).rejects.toMatchObject({ code: "GITHUB_LABEL_READBACK_MISMATCH" });
    github.applyLabelWrites = true;
  });

  it("addComment POSTs the comment body", async () => {
    await addComment(ctx, "acme/widgets", 7, "on it");
    const req = github.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/repos/acme/widgets/issues/7/comments");
    expect(req.body).toMatchObject({ body: "on it" });
  });

  it("listIssues passes state/label filters and drops pull requests from the result", async () => {
    const issues = await listIssues(ctx, "acme/widgets", {
      state: "open",
      labels: ["bug"],
    });
    const req = github.lastRequest();
    expect(req.method).toBe("GET");
    expect(req.path).toContain("/repos/acme/widgets/issues");
    expect(req.path).toContain("state=open");
    expect(req.path).toContain("labels=bug");
    // The server returned an issue AND a pull_request row; only the issue maps.
    expect(issues.map((i) => i.number)).toEqual([7]);
  });

  it("a 422 from the API surfaces as a thrown error, not a fabricated issue", async () => {
    github.failNext = { status: 422, message: "Validation Failed" };
    await expect(
      createIssue(ctx, "acme/widgets", { title: "", body: "" }),
    ).rejects.toThrow(/Validation Failed|422/);
  });

  it("a 404 from the API surfaces on update instead of returning a default", async () => {
    github.failNext = { status: 404, message: "Not Found" };
    await expect(
      updateIssue(ctx, "acme/widgets", 999, { title: "x" }),
    ).rejects.toThrow(/Not Found|404/);
  });
});
