/**
 * Exercises Electrobun release identity through an ephemeral GitHub API and
 * validates the workflow wiring that consumes it. The real HTTP boundary
 * covers lightweight and annotated tags, drift, malformed input, canonical
 * Release identity, and the upload-only publication contract.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import http, { type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ElectrobunReleaseIdentityError,
  parseReleaseTag,
  resolveElectrobunReleaseSource,
  resolveGitHubTag,
  selectReleaseTag,
  verifyExistingElectrobunRelease,
} from "../electrobun-release-identity.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const workflowPath = path.join(
  repoRoot,
  ".github/workflows/release-electrobun.yml",
);
const workflowSource = fs.readFileSync(workflowPath, "utf8");
const identityScript = path.join(
  repoRoot,
  "packages/scripts/electrobun-release-identity.mjs",
);
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const TAG_OBJECT_A = "c".repeat(40);
const TAG_OBJECT_B = "d".repeat(40);

interface WorkflowStep {
  name?: string;
  env?: Record<string, string>;
  run?: string;
  uses?: string;
  with?: Record<string, string | number | boolean>;
}

interface WorkflowJob {
  if?: string;
  name?: string;
  needs?: string | string[];
  environment?: string;
  outputs?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

interface RouteResponse {
  body: unknown;
  status?: number;
  raw?: boolean;
}

const workflow = Bun.YAML.parse(workflowSource) as Workflow;
const servers: Server[] = [];
const roots: string[] = [];

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

function requireJob(id: string): WorkflowJob {
  const job = workflow.jobs?.[id];
  if (!job) throw new Error(`Missing workflow job: ${id}`);
  return job;
}

function requireStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Missing workflow step: ${name}`);
  return step;
}

async function startApi(routes: Record<string, RouteResponse>) {
  const requests: Array<{
    authorization: string | undefined;
    method: string | undefined;
    url: string | undefined;
  }> = [];
  const server = http.createServer((request, response) => {
    requests.push({
      authorization: request.headers.authorization,
      method: request.method,
      url: request.url,
    });
    const route = routes[request.url ?? ""];
    if (!route) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }
    response.writeHead(route.status ?? 200, {
      "content-type": "application/json",
    });
    response.end(route.raw ? String(route.body) : JSON.stringify(route.body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to bind GitHub fixture API");
  }
  return {
    apiUrl: `http://127.0.0.1:${address.port}/api/`,
    requests,
  };
}

function tagRef(type: string, sha: string) {
  return { ref: "refs/tags/v1.2.3", object: { type, sha } };
}

function release(overrides: Record<string, unknown> = {}) {
  return {
    id: 71,
    tag_name: "v1.2.3",
    target_commitish: COMMIT_A,
    draft: false,
    prerelease: false,
    ...overrides,
  };
}

describe("Electrobun release tag validation", () => {
  test.each([
    ["v0.0.0", "stable", false],
    ["v1.2.3", "stable", false],
    ["v1.2.3-beta.0", "canary", true],
    ["v1.2.3-rc.1+build.9", "canary", true],
    ["v1.2.3+build.01", "stable", false],
  ])("accepts strict tag %s", (tag, channel, prerelease) => {
    expect(parseReleaseTag(tag)).toMatchObject({
      tag,
      version: tag.slice(1),
      channel,
      prerelease,
    });
  });

  test.each([
    "1.2.3",
    "v01.2.3",
    "v1.02.3",
    "v1.2.03",
    "v1.2",
    "v1.2.3-01",
    "v1.2.3-beta.01",
    "v1.2.3-",
    "v1.2.3+",
    "v1.2.3;echo-pwned",
  ])("rejects malformed tag %s", (tag) => {
    try {
      parseReleaseTag(tag);
      throw new Error("Expected malformed tag to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ElectrobunReleaseIdentityError);
      expect((error as Error).message).toContain("Malformed release tag");
      expect((error as Error).message.split("\n")).toHaveLength(1);
    }
  });

  test("escapes control characters in invalid-tag diagnostics", () => {
    try {
      parseReleaseTag("v1.2.3\n::warning::pwned");
      throw new Error("Expected malformed tag to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ElectrobunReleaseIdentityError);
      expect((error as Error).message).toContain("\\n::warning::pwned");
      expect((error as Error).message.split("\n")).toHaveLength(1);
    }
  });

  test("requires an explicit tag outside a tag ref", () => {
    expect(() =>
      selectReleaseTag({ inputTag: "", refType: "branch", refName: "develop" }),
    ).toThrow("must provide an existing release tag");
    expect(
      selectReleaseTag({ inputTag: "", refType: "tag", refName: "v1.2.3" }),
    ).toMatchObject({ tag: "v1.2.3" });
  });
});

describe("Electrobun GitHub identity boundary", () => {
  test("resolves a lightweight tag and binds a tag-push SHA", async () => {
    const api = await startApi({
      "/api/repos/elizaOS/eliza/git/ref/tags/v1.2.3": {
        body: tagRef("commit", COMMIT_A),
      },
    });
    const result = await resolveElectrobunReleaseSource({
      apiUrl: api.apiUrl,
      repository: "elizaOS/eliza",
      inputTag: "",
      refType: "tag",
      refName: "v1.2.3",
      eventName: "push",
      eventSha: COMMIT_A,
      token: "fixture-token",
    });
    expect(result).toMatchObject({
      tag: "v1.2.3",
      sourceSha: COMMIT_A,
      peelDepth: 0,
    });
    expect(api.requests).toEqual([
      {
        authorization: "Bearer fixture-token",
        method: "GET",
        url: "/api/repos/elizaOS/eliza/git/ref/tags/v1.2.3",
      },
    ]);
  });

  test("recursively peels annotated tags to a commit", async () => {
    const api = await startApi({
      "/api/repos/elizaOS/eliza/git/ref/tags/v1.2.3": {
        body: tagRef("tag", TAG_OBJECT_A),
      },
      [`/api/repos/elizaOS/eliza/git/tags/${TAG_OBJECT_A}`]: {
        body: { object: { type: "tag", sha: TAG_OBJECT_B } },
      },
      [`/api/repos/elizaOS/eliza/git/tags/${TAG_OBJECT_B}`]: {
        body: { object: { type: "commit", sha: COMMIT_A } },
      },
    });
    await expect(
      resolveGitHubTag({
        apiUrl: api.apiUrl,
        repository: "elizaOS/eliza",
        tag: "v1.2.3",
        token: "fixture-token",
      }),
    ).resolves.toEqual({ sourceSha: COMMIT_A, peelDepth: 2 });
  });

  test("fails closed when annotated tags form a cycle", async () => {
    const api = await startApi({
      "/api/repos/elizaOS/eliza/git/ref/tags/v1.2.3": {
        body: tagRef("tag", TAG_OBJECT_A),
      },
      [`/api/repos/elizaOS/eliza/git/tags/${TAG_OBJECT_A}`]: {
        body: { object: { type: "tag", sha: TAG_OBJECT_B } },
      },
      [`/api/repos/elizaOS/eliza/git/tags/${TAG_OBJECT_B}`]: {
        body: { object: { type: "tag", sha: TAG_OBJECT_A } },
      },
    });
    await expect(
      resolveGitHubTag({
        apiUrl: api.apiUrl,
        repository: "elizaOS/eliza",
        tag: "v1.2.3",
        token: "fixture-token",
      }),
    ).rejects.toMatchObject({ kind: "conflict" });
    expect(api.requests).toHaveLength(3);
  });

  test("rejects push mismatch, missing refs, malformed JSON, and non-commit targets", async () => {
    const mismatchApi = await startApi({
      "/api/repos/elizaOS/eliza/git/ref/tags/v1.2.3": {
        body: tagRef("commit", COMMIT_A),
      },
    });
    await expect(
      resolveElectrobunReleaseSource({
        apiUrl: mismatchApi.apiUrl,
        repository: "elizaOS/eliza",
        inputTag: "v1.2.3",
        refType: "branch",
        refName: "develop",
        eventName: "push",
        eventSha: COMMIT_B,
        token: "fixture-token",
      }),
    ).rejects.toThrow("does not match peeled tag commit");

    const missingApi = await startApi({});
    try {
      await resolveGitHubTag({
        apiUrl: missingApi.apiUrl,
        repository: "elizaOS/eliza",
        tag: "v1.2.3",
        token: "fixture-token",
      });
      throw new Error("Expected a missing tag to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ElectrobunReleaseIdentityError);
      expect((error as ElectrobunReleaseIdentityError).kind).toBe("not-found");
      expect((error as ElectrobunReleaseIdentityError).status).toBe(404);
    }

    const malformedApi = await startApi({
      "/api/repos/elizaOS/eliza/git/ref/tags/v1.2.3": {
        body: "not-json",
        raw: true,
      },
    });
    await expect(
      resolveGitHubTag({
        apiUrl: malformedApi.apiUrl,
        repository: "elizaOS/eliza",
        tag: "v1.2.3",
        token: "fixture-token",
      }),
    ).rejects.toMatchObject({ kind: "malformed-response" });

    const treeApi = await startApi({
      "/api/repos/elizaOS/eliza/git/ref/tags/v1.2.3": {
        body: tagRef("tree", COMMIT_A),
      },
    });
    await expect(
      resolveGitHubTag({
        apiUrl: treeApi.apiUrl,
        repository: "elizaOS/eliza",
        tag: "v1.2.3",
        token: "fixture-token",
      }),
    ).rejects.toThrow("is not a commit");
  });

  test("preserves transport causes without exposing response bodies", async () => {
    const cause = new Error("fixture socket closed");
    try {
      await resolveGitHubTag({
        repository: "elizaOS/eliza",
        tag: "v1.2.3",
        token: "fixture-token",
        fetchImpl: async () => {
          throw cause;
        },
      });
      throw new Error("Expected transport failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ElectrobunReleaseIdentityError);
      expect((error as ElectrobunReleaseIdentityError).kind).toBe("transport");
      expect((error as Error).cause).toBe(cause);
      expect((error as Error).message).not.toContain("fixture socket closed");
    }
  });

  test("verifies the tag and canonical non-draft Release exact identity", async () => {
    const api = await startApi({
      "/api/repos/elizaOS/eliza/git/ref/tags/v1.2.3": {
        body: tagRef("commit", COMMIT_A),
      },
      "/api/repos/elizaOS/eliza/releases/tags/v1.2.3": {
        body: release(),
      },
    });
    await expect(
      verifyExistingElectrobunRelease({
        apiUrl: api.apiUrl,
        repository: "elizaOS/eliza",
        tag: "v1.2.3",
        expectedCommit: COMMIT_A,
        token: "fixture-token",
      }),
    ).resolves.toEqual({
      releaseId: 71,
      sourceSha: COMMIT_A,
      tag: "v1.2.3",
      prerelease: false,
    });
  });

  test("rejects tag drift before reading or mutating a Release", async () => {
    const api = await startApi({
      "/api/repos/elizaOS/eliza/git/ref/tags/v1.2.3": {
        body: tagRef("commit", COMMIT_B),
      },
    });
    await expect(
      verifyExistingElectrobunRelease({
        apiUrl: api.apiUrl,
        repository: "elizaOS/eliza",
        tag: "v1.2.3",
        expectedCommit: COMMIT_A,
        token: "fixture-token",
      }),
    ).rejects.toThrow(`moved from prepared commit ${COMMIT_A} to ${COMMIT_B}`);
    expect(api.requests).toHaveLength(1);
  });

  test.each([
    ["different target", { target_commitish: COMMIT_B }],
    ["draft release", { draft: true }],
    ["wrong prerelease state", { prerelease: true }],
    ["wrong tag", { tag_name: "v1.2.4" }],
  ])("rejects a canonical Release with %s", async (_name, overrides) => {
    const api = await startApi({
      "/api/repos/elizaOS/eliza/git/ref/tags/v1.2.3": {
        body: tagRef("commit", COMMIT_A),
      },
      "/api/repos/elizaOS/eliza/releases/tags/v1.2.3": {
        body: release(overrides),
      },
    });
    await expect(
      verifyExistingElectrobunRelease({
        apiUrl: api.apiUrl,
        repository: "elizaOS/eliza",
        tag: "v1.2.3",
        expectedCommit: COMMIT_A,
        token: "fixture-token",
      }),
    ).rejects.toMatchObject({ kind: "conflict" });
  });

  test("CLI writes only validated source identity to GitHub output", async () => {
    const api = await startApi({
      "/api/repos/elizaOS/eliza/git/ref/tags/v1.2.3-beta.1": {
        body: {
          ref: "refs/tags/v1.2.3-beta.1",
          object: { type: "commit", sha: COMMIT_A },
        },
      },
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "electrobun-identity-"));
    roots.push(root);
    const githubOutput = path.join(root, "github-output");
    const processHandle = Bun.spawn(
      [
        "node",
        identityScript,
        "resolve",
        "--repository",
        "elizaOS/eliza",
        "--input-tag",
        "v1.2.3-beta.1",
        "--ref-type",
        "branch",
        "--ref-name",
        "develop",
        "--event-name",
        "workflow_dispatch",
        "--event-sha",
        COMMIT_B,
        "--github-output",
        githubOutput,
      ],
      {
        env: {
          ...process.env,
          GH_TOKEN: "fixture-token",
          GITHUB_API_URL: api.apiUrl,
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({
      tag: "v1.2.3-beta.1",
      sourceSha: COMMIT_A,
      channel: "canary",
    });
    expect(fs.readFileSync(githubOutput, "utf8")).toBe(
      `tag=v1.2.3-beta.1\nversion=1.2.3-beta.1\nenv=canary\nsource_sha=${COMMIT_A}\n`,
    );
  });
});

describe("release-electrobun workflow binding", () => {
  test("prepare executes trusted identity tooling and exports its source SHA", () => {
    const prepare = requireJob("prepare");
    const checkout = requireStep(prepare, "Checkout");
    const resolve = requireStep(prepare, "Resolve tag to peeled commit");
    expect(checkout.with?.ref).toBe(`\${{ github.workflow_sha }}`);
    expect(checkout.with?.["persist-credentials"]).toBe(false);
    expect(resolve.run).toContain(
      "node packages/scripts/electrobun-release-identity.mjs resolve",
    );
    expect(resolve.run).not.toMatch(/\$\{\{.*(?:inputs|github)\./);
    expect(prepare.outputs?.source_sha).toBe(
      `\${{ steps.version.outputs.source_sha }}`,
    );
  });

  test.each(["validate-release", "build", "release", "ota-publish"])(
    "%s checks out and verifies the exact prepared commit",
    (jobId) => {
      const job = requireJob(jobId);
      const checkout = requireStep(job, "Checkout tagged commit");
      const verify = requireStep(job, "Verify checkout matches tagged commit");
      expect(checkout.with?.ref).toBe(
        `\${{ needs.prepare.outputs.source_sha }}`,
      );
      expect(verify.env?.EXPECTED_SHA).toBe(
        `\${{ needs.prepare.outputs.source_sha }}`,
      );
      expect(verify.run).toContain("git rev-parse HEAD");
      expect(verify.run).not.toContain("${{");
    },
  );

  test.each(["release", "ota-publish"])(
    "%s reverifies tag and Release identity with trusted tooling",
    (jobId) => {
      const job = requireJob(jobId);
      const tooling = requireStep(job, "Checkout trusted release tooling");
      const verify = requireStep(
        job,
        "Reverify canonical tag and GitHub Release",
      );
      expect(tooling.with?.ref).toBe(`\${{ github.workflow_sha }}`);
      expect(tooling.with?.["persist-credentials"]).toBe(false);
      expect(verify.run).toContain(
        ".release-tooling/packages/scripts/electrobun-release-identity.mjs verify",
      );
      expect(verify.env?.EXPECTED_SHA).toBe(
        `\${{ needs.prepare.outputs.source_sha }}`,
      );
    },
  );

  test("public upload is non-draft, upload-only, and never clobbers assets", () => {
    const releaseJob = requireJob("release");
    const upload = requireStep(releaseJob, "Upload assets to GitHub Release");
    expect(releaseJob.name).toBe("Upload Release Assets");
    expect(releaseJob.if).toContain("!inputs.draft");
    expect(upload.run).toContain("gh release upload");
    expect(upload.run).not.toMatch(/gh release upload[^\n]*--clobber/);
    expect(workflowSource).not.toContain("softprops/action-gh-release");
  });

  test("OTA publication fails closed and never replaces an existing manifest", () => {
    const ota = requireJob("ota-publish");
    const attach = requireStep(
      ota,
      "Attach channel manifest to GitHub Release",
    );
    expect(attach.run).toContain("gh release upload");
    expect(attach.run).not.toMatch(/gh release upload[^\n]*--clobber/);
    expect(attach.run).not.toContain("exit 0");
  });

  test("source binding never derives from the dispatch SHA", () => {
    for (const line of workflowSource
      .split("\n")
      .filter((candidate) => candidate.includes("source_sha="))) {
      expect(line).not.toContain("$GITHUB_SHA");
    }
  });

  test("every signing and publishing job is gated on the production-release approval", () => {
    const needsList = (job: WorkflowJob): string[] =>
      typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);

    const authorize = requireJob("authorize-release");
    expect(authorize.environment).toBe("production-release");
    expect(needsList(authorize)).toEqual(["prepare"]);
    // Approval marker only: no checkout, so the gate itself can never run
    // pipeline code or touch signing secrets.
    expect(authorize.steps ?? []).toHaveLength(1);
    for (const step of authorize.steps ?? []) {
      expect(step.uses ?? "").not.toContain("checkout");
    }

    const build = requireJob("build");
    expect(needsList(build)).toEqual(
      expect.arrayContaining([
        "prepare",
        "validate-release",
        "authorize-release",
      ]),
    );
    expect(build.if).toContain("needs.authorize-release.result == 'success'");

    // Downstream jobs inherit the gate only if they fail closed when build is
    // skipped: no `always()` without an explicit build-result check.
    const releaseJob = requireJob("release");
    expect(needsList(releaseJob)).toEqual(
      expect.arrayContaining(["prepare", "build"]),
    );
    expect(releaseJob.if ?? "").not.toContain("always()");

    const ota = requireJob("ota-publish");
    expect(needsList(ota)).toEqual(
      expect.arrayContaining(["prepare", "release"]),
    );
    expect(ota.if ?? "").toContain("needs.release.result == 'success'");
  });

  test("prepare refuses a tagged commit that never landed on a protected branch", () => {
    const prepare = requireJob("prepare");
    const checkout = requireStep(prepare, "Checkout");
    expect(checkout.with?.["fetch-depth"]).toBe(0);

    const resolve = requireStep(prepare, "Resolve tag to peeled commit");
    const ancestry = requireStep(
      prepare,
      "Require tagged commit on a protected branch",
    );
    // The checked commit is exactly the identity-validated source_sha that
    // downstream jobs build and publish, and the step runs after resolution.
    expect(ancestry.env?.SOURCE_SHA).toBe(
      `\${{ steps.version.outputs.source_sha }}`,
    );
    const steps = prepare.steps ?? [];
    expect(steps.indexOf(ancestry)).toBeGreaterThan(steps.indexOf(resolve));

    expect(ancestry.run).toContain(
      'git merge-base --is-ancestor "$SOURCE_SHA" origin/main',
    );
    expect(ancestry.run).toContain(
      'git merge-base --is-ancestor "$SOURCE_SHA" origin/develop',
    );
    expect(ancestry.run).toContain("exit 1");
  });
});
