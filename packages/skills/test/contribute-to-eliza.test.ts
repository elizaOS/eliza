/**
 * Verifies the bundled contributor skill, its local references, and its
 * read-only GitHub report using deterministic API fixtures.
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  auditCommentDisclosures,
  auditPrEvidence,
  CLAIM_RECENCY_DAYS,
  collectLiveReport,
  isBotAccount,
  parseCliArguments,
  parseModelDisclosure,
  parsePaginatedJson,
  REQUIRED_EVIDENCE_ROWS,
  readGhPages,
  renderMarkdown,
} from "../skills/contribute-to-eliza/scripts/live-report.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const skillDir = join(testDir, "..", "skills", "contribute-to-eliza");
const skillPath = join(skillDir, "SKILL.md");
const liveReportPath = join(skillDir, "scripts", "live-report.mjs");
const NOW = new Date("2026-01-20T12:00:00.000Z");
const HEAD_SHA = "a".repeat(40);
const PRIOR_SHA = "b".repeat(40);

function account(login: string, type = "User") {
  const id = [...login.toLowerCase()].reduce(
    (value, character) => (value * 31 + character.charCodeAt(0)) % 1_000_000,
    17,
  );
  return { id, login, type };
}

function comment(
  id: number,
  author: string,
  body: string | null,
  kind = "User",
  createdAt = "2026-01-18T12:00:00.000Z",
  authorAssociation = "MEMBER",
) {
  return {
    id,
    html_url: `https://github.com/elizaOS/eliza/comments/${id}`,
    user: account(author, kind),
    body,
    created_at: createdAt,
    author_association: authorAssociation,
  };
}

function review(
  id: number,
  author: string | null,
  state: string,
  commitId = HEAD_SHA,
  submittedAt = "2026-01-18T12:00:00.000Z",
) {
  return {
    id,
    html_url: `https://github.com/elizaOS/eliza/pull/1#pullrequestreview-${id}`,
    user: author === null ? null : account(author),
    body: "Substantive review findings.",
    submitted_at: submittedAt,
    state,
    commit_id: commitId,
  };
}

function pullRequest(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: `Pull request ${number}`,
    html_url: `https://github.com/elizaOS/eliza/pull/${number}`,
    user: account(`author-${number}`),
    labels: [],
    assignees: [],
    draft: false,
    body: evidenceBody(),
    requested_reviewers: [],
    requested_teams: [],
    created_at: "2026-01-18T12:00:00.000Z",
    updated_at: "2026-01-18T12:00:00.000Z",
    head: { sha: HEAD_SHA },
    ...overrides,
  };
}

function evidenceBody() {
  const rows = REQUIRED_EVIDENCE_ROWS.map(
    (id) =>
      `<!-- evidence-row:${id} -->\n- [x] ${id}: N/A - no affected ${id} surface.`,
  ).join("\n\n");
  return `${rows}\n\nAI provider/model: OpenAI / gpt-5.6-codex`;
}

describe("contribute-to-eliza skill structure", () => {
  it("has valid, trigger-rich frontmatter and no scaffold placeholders", () => {
    const source = readFileSync(skillPath, "utf8");
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(frontmatter, "SKILL.md must begin with YAML frontmatter");
    const keys = frontmatter[1]
      .split(/\r?\n/)
      .map((line) => line.match(/^([a-z-]+):/)?.[1])
      .filter((key): key is string => key !== undefined);
    const name = frontmatter[1].match(/^name:\s*(.+)$/m)?.[1];
    const description = frontmatter[1].match(
      /^description:\s*"?(.+?)"?$/m,
    )?.[1];

    assert.deepStrictEqual(keys.sort(), ["description", "name"]);
    assert.strictEqual(name, "contribute-to-eliza");
    assert.match(
      String(description),
      /issue.*pull request|pull request.*issue/i,
    );
    assert.doesNotMatch(source, /\[TODO[:\]]/);
  });

  it("encodes both modes, optional disclosure, security, sync, proof, and authority", () => {
    const source = readFileSync(skillPath, "utf8");

    assert.match(source, /Mode A: finish a scoped issue/);
    assert.match(source, /Mode B: independently review and repair/);
    assert.match(source, /AI provider\/model: <provider> \/ <exact-model-id>/);
    assert.match(source, /disclosure is optional/i);
    assert.match(source, /must never block GitHub work/i);
    assert.match(source, /Missing model identity is not a blocker/i);
    assert.match(source, /— \[<lane-tag>\]/);
    assert.match(source, /lane signature immediately precedes/i);
    assert.match(source, /eliza-computer-attribution:v1/);
    assert.match(source, /Contribution skill revision:/);
    assert.match(source, /PROVENANCE\.json/);
    assert.match(source, /source\.sha256/);
    assert.match(source, /revisionStatus.*committed/);
    assert.match(source, /never substitute[\s\S]*guessed SHA/i);
    assert.match(source, /packages\/docs\/security\.md/);
    assert.match(source, /origin\/develop/);
    assert.match(source, /package-local `AGENTS\.md` or `CLAUDE\.md`/);
    assert.match(source, /manually inspect every trajectory, log, screenshot/);
    assert.match(source, /Never self-approve or self-merge/);
    assert.match(source, /--no-ext-diff --no-textconv/);
    assert.match(source, /worktree alone is not isolation/i);
    assert.match(source, /network denied by\s+default/i);
    assert.match(source, /bun install --frozen-lockfile --ignore-scripts/);
    assert.match(source, /explicit operator approval/i);
    assert.match(source, /ephemeral,\s+least-privilege credential/i);
    assert.match(source, /normal `gh` token, credential helper/i);
  });

  it("states the reward without implying a payout formula and links safe wallet setup", () => {
    const source = readFileSync(skillPath, "utf8");

    assert.match(source, /\$10,000 monthly USDC pool/);
    assert.match(source, /do not define or guarantee\s+a payout/i);
    assert.match(source, /https:\/\/eliza\.app\/profile\/edit/);
    assert.match(source, /public.*Solana or Ethereum address/i);
    assert.match(source, /hidden\s+GitHub README comment/i);
    assert.match(
      source,
      /Never enter or share a\s+private key or seed phrase/i,
    );
  });

  it("suppresses an untrusted postinstall and sanitizes a test fixture environment", {
    timeout: 30_000,
  }, () => {
    const fixtureRoot = mkdtempSync(
      join(tmpdir(), "contribute-to-eliza-untrusted-pr-"),
    );
    const isolatedHome = join(fixtureRoot, "isolated-home");
    const postinstallSentinel = join(fixtureRoot, "postinstall-executed");
    const testProbe = join(fixtureRoot, "test-environment.json");
    try {
      mkdirSync(isolatedHome);
      writeFileSync(
        join(fixtureRoot, "package.json"),
        `${JSON.stringify(
          {
            name: "malicious-pr-fixture",
            private: true,
            scripts: {
              postinstall:
                'node -e "require(\\"node:fs\\").writeFileSync(\\"postinstall-executed\\", process.env.GITHUB_TOKEN || \\"executed\\")"',
              test: "node probe.mjs",
            },
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(
        join(fixtureRoot, "probe.mjs"),
        `
import { writeFileSync } from "node:fs";

const sensitiveNames = Object.keys(process.env).filter((name) =>
  /^(?:GH_|GITHUB_|AWS_|CLOUDFLARE_|ANTHROPIC_|OPENAI_)/u.test(name),
);
writeFileSync(
  "test-environment.json",
  JSON.stringify({
    sensitiveNames,
    home: process.env.HOME,
    gitConfigGlobal: process.env.GIT_CONFIG_GLOBAL,
    gitConfigSystem: process.env.GIT_CONFIG_SYSTEM,
  }),
);
`,
      );
      const safeEnvironment = {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        HOME: isolatedHome,
        PATH: process.env.PATH ?? "",
        TMPDIR: fixtureRoot,
      };
      const install = spawnSync(
        "bun",
        ["install", "--ignore-scripts", "--offline"],
        {
          cwd: fixtureRoot,
          encoding: "utf8",
          env: safeEnvironment,
        },
      );
      assert.strictEqual(install.status, 0, install.stderr);
      assert.strictEqual(existsSync(postinstallSentinel), false);

      const frozenInstall = spawnSync(
        "bun",
        ["install", "--frozen-lockfile", "--ignore-scripts", "--offline"],
        {
          cwd: fixtureRoot,
          encoding: "utf8",
          env: safeEnvironment,
        },
      );
      assert.strictEqual(frozenInstall.status, 0, frozenInstall.stderr);
      assert.strictEqual(existsSync(postinstallSentinel), false);

      const testRun = spawnSync("bun", ["run", "test"], {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: safeEnvironment,
      });
      assert.strictEqual(testRun.status, 0, testRun.stderr);
      const observed = JSON.parse(readFileSync(testProbe, "utf8")) as {
        sensitiveNames: string[];
        home: string;
        gitConfigGlobal: string;
        gitConfigSystem: string;
      };
      assert.deepStrictEqual(observed, {
        sensitiveNames: [],
        home: isolatedHome,
        gitConfigGlobal: "/dev/null",
        gitConfigSystem: "/dev/null",
      });
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("links only existing local references and ships UI metadata", () => {
    const source = readFileSync(skillPath, "utf8");
    const references = [...source.matchAll(/\]\((references\/[^)]+)\)/g)].map(
      (match) => match[1],
    );

    assert.deepStrictEqual(references.sort(), [
      "references/evidence-review-rubric.md",
      "references/repository-contract.md",
    ]);
    for (const reference of references) {
      assert.ok(existsSync(join(skillDir, reference)), reference);
    }

    const openaiYaml = readFileSync(
      join(skillDir, "agents", "openai.yaml"),
      "utf8",
    );
    assert.match(openaiYaml, /display_name: "Contribute to elizaOS"/);
    assert.match(openaiYaml, /default_prompt: "Use \$contribute-to-eliza/);
    assert.match(openaiYaml, /one scoped elizaOS issue/);
    assert.match(openaiYaml, /independently review one open pull request/);
  });
});

describe("live report parsing", () => {
  it("runs the CLI when its entrypoint reaches the module through a symlink", () => {
    const fixtureRoot = mkdtempSync(
      join(tmpdir(), "contribute-to-eliza-live-report-"),
    );
    const linkedEntrypoint = join(fixtureRoot, "live-report.mjs");
    try {
      symlinkSync(liveReportPath, linkedEntrypoint);
      assert.notStrictEqual(linkedEntrypoint, realpathSync(linkedEntrypoint));

      const result = spawnSync(process.execPath, [linkedEntrypoint, "--help"], {
        encoding: "utf8",
      });

      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /^Usage: node scripts\/live-report\.mjs/m);
      assert.strictEqual(result.stderr, "");
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("parses ordered newline-delimited records from every gh page", () => {
    assert.deepStrictEqual(
      parsePaginatedJson(
        '{"number":1,"body":"first\\nrecord"}\n{"number":2}\n',
        "repos/elizaOS/eliza/issues",
      ),
      [{ number: 1, body: "first\nrecord" }, { number: 2 }],
    );
    assert.deepStrictEqual(parsePaginatedJson("\n\r\n"), []);
  });

  it("rejects malformed or truncated paginated records with endpoint context", () => {
    assert.throws(
      () =>
        parsePaginatedJson(
          '{"number":1}\n{"number":',
          "repos/elizaOS/eliza/issues?state=open",
        ),
      /malformed JSON.*repos\/elizaOS\/eliza\/issues\?state=open.*line 2/,
    );
    assert.throws(
      () => parsePaginatedJson(null as unknown as string, "issues endpoint"),
      /did not return text output for issues endpoint/,
    );
  });

  it("accepts exact provider/model pairs and rejects placeholders", () => {
    assert.deepStrictEqual(
      parseModelDisclosure("**AI provider/model:** OpenAI / gpt-5.6-codex"),
      { provider: "OpenAI", model: "gpt-5.6-codex" },
    );
    assert.deepStrictEqual(
      parseModelDisclosure(
        "AI provider/model: OpenRouter / anthropic/claude-opus-4.1",
      ),
      {
        provider: "OpenRouter",
        model: "anthropic/claude-opus-4.1",
      },
    );
    assert.strictEqual(
      parseModelDisclosure("AI provider/model: unknown / model"),
      null,
    );
    assert.strictEqual(
      parseModelDisclosure("AI provider/model: AI / gpt-5.4"),
      null,
    );
    assert.strictEqual(
      parseModelDisclosure("AI provider/model: None / gpt-5.4"),
      null,
    );
    for (const generic of [
      "AI provider/model: N_A / gpt-5.4",
      "AI provider/model: OpenAI / N/A",
      "AI provider/model: OpenRouter / anthropic/gpt",
    ]) {
      assert.strictEqual(parseModelDisclosure(generic), null, generic);
    }
    assert.strictEqual(
      parseModelDisclosure("AI provider/model: OpenAI/gpt-5"),
      null,
    );
    for (const policyDiscussion of [
      "The `AI provider/model:` field in your comment is malformed.",
      "> AI provider/model: quoted / example",
      "```text\nAI provider/model: example / example-model\n```",
    ]) {
      assert.strictEqual(parseModelDisclosure(policyDiscussion), null);
    }
  });

  it("accepts only trusted category-scoped evidence or a specific N/A reason", () => {
    assert.strictEqual(auditPrEvidence(evidenceBody()).ok, true);

    const trustedRows = new Map([
      [
        "before-screenshots",
        "https://github.com/user-attachments/assets/11111111-1111-1111-1111-111111111111",
      ],
      [
        "after-screenshots",
        "https://github.com/user-attachments/assets/22222222-2222-2222-2222-222222222222",
      ],
      [
        "walkthrough-video",
        "https://github.com/user-attachments/assets/33333333-3333-3333-3333-333333333333",
      ],
      [
        "backend-logs",
        `https://github.com/elizaOS/eliza/blob/${HEAD_SHA}/evidence/backend.log`,
      ],
      [
        "frontend-logs",
        "https://github.com/elizaOS/eliza/actions/runs/123456/artifacts/7890",
      ],
      [
        "llm-trajectory",
        `https://raw.githubusercontent.com/elizaOS/eliza/${HEAD_SHA}/trajectory.json`,
      ],
      ["domain-artifacts", `https://etherscan.io/tx/0x${"c".repeat(64)}`],
    ]);
    const trustedBody = REQUIRED_EVIDENCE_ROWS.map(
      (id) =>
        `<!-- evidence-row:${id} -->\n- [x] ${id}: ${trustedRows.get(id)}`,
    ).join("\n\n");
    assert.strictEqual(auditPrEvidence(trustedBody).ok, true);

    const placeholderBody = REQUIRED_EVIDENCE_ROWS.map(
      (id) =>
        `<!-- evidence-row:${id} -->\n- [ ] ${id}, or marked N/A - <reason>.`,
    ).join("\n\n");
    const audit = auditPrEvidence(placeholderBody);
    assert.strictEqual(audit.ok, false);
    assert.ok(
      audit.findings.every((finding) => finding.status === "unsatisfied"),
    );

    for (const untrusted of [
      "https://example.com/proof.png",
      "https://github.com/elizaOS/eliza/issues/123",
      "https://github.com/elizaOS/eliza/blob/develop/evidence/proof.json",
      `https://etherscan.io/tx/0x${"d".repeat(64)}`,
    ]) {
      const body = REQUIRED_EVIDENCE_ROWS.map(
        (id) => `<!-- evidence-row:${id} -->\n- [x] ${id}: ${untrusted}`,
      ).join("\n\n");
      const findings = auditPrEvidence(body).findings;
      if (untrusted.includes("etherscan.io")) {
        assert.ok(
          findings
            .filter((finding) => finding.id !== "domain-artifacts")
            .every((finding) => finding.status === "unsatisfied"),
        );
      } else {
        assert.ok(
          findings.every((finding) => finding.status === "unsatisfied"),
        );
      }
    }

    const vagueNa = REQUIRED_EVIDENCE_ROWS.map(
      (id) => `<!-- evidence-row:${id} -->\n- [ ] ${id}: N/A - none`,
    ).join("\n\n");
    assert.ok(
      auditPrEvidence(vagueNa).findings.every(
        (finding) => finding.status === "unsatisfied",
      ),
    );

    const missing = auditPrEvidence(
      evidenceBody().replace(
        /<!-- evidence-row:backend-logs -->[\s\S]*?(?=<!-- evidence-row:frontend-logs -->)/,
        "",
      ),
    );
    assert.strictEqual(
      missing.findings.find((finding) => finding.id === "backend-logs")?.status,
      "missing",
    );
  });

  it("accepts substantive inline details only for backend and frontend logs", () => {
    const withEvidenceRow = (target: string, value: string) =>
      REQUIRED_EVIDENCE_ROWS.map((id) =>
        id === target
          ? `<!-- evidence-row:${id} -->\n${value}`
          : `<!-- evidence-row:${id} -->\n- [x] ${id}: N/A - no affected ${id} surface.`,
      ).join("\n\n");
    const backendDetails = [
      "- [x] Backend logs from the exercised request:",
      "",
      "<details>",
      "<summary>Structured backend log output</summary>",
      "",
      "```text",
      "2026-01-18T12:00:00.100Z INFO [AgentRuntime] request started roomId=room-42 action=REPLY",
      "2026-01-18T12:00:00.480Z INFO [AgentRuntime] request completed roomId=room-42 status=success",
      "```",
      "</details>",
    ].join("\n");
    const frontendDetails = [
      "- [x] Frontend console and network output:",
      "<details>",
      "<summary>Browser output</summary>",
      "```text",
      "[2026-01-18T12:00:00.500Z] console.info [ElizaComputer] leaderboard loaded entries=25",
      "GET https://eliza.army/data/leaderboard.json 200 duration=84ms",
      "```",
      "</details>",
    ].join("\n");

    assert.strictEqual(
      auditPrEvidence(withEvidenceRow("backend-logs", backendDetails)).ok,
      true,
    );
    assert.strictEqual(
      auditPrEvidence(withEvidenceRow("frontend-logs", frontendDetails)).ok,
      true,
    );
    assert.strictEqual(
      auditPrEvidence(
        withEvidenceRow("frontend-logs", backendDetails),
      ).findings.find((finding) => finding.id === "frontend-logs")?.status,
      "unsatisfied",
    );
    assert.strictEqual(
      auditPrEvidence(
        withEvidenceRow("backend-logs", frontendDetails),
      ).findings.find((finding) => finding.id === "backend-logs")?.status,
      "unsatisfied",
    );

    for (const invalidDetails of [
      "- [x] Logs\n<details><summary>Logs</summary></details>",
      [
        "- [x] Logs",
        "<details>",
        "<summary>Logs</summary>",
        "```text",
        "<paste logs here>",
        "```",
        "</details>",
      ].join("\n"),
      [
        "- [x] Logs",
        "<details>",
        "<summary>Review notes</summary>",
        "This prose says that logs were captured and carefully reviewed.",
        "It contains no structured output from the exercised runtime path.",
        "</details>",
      ].join("\n"),
      [
        "- [x] Logs",
        "<details>",
        "<summary>Long prose in a code block</summary>",
        "```text",
        "The feature was opened in a browser and appeared to behave correctly.",
        "The reviewer checked the result twice but included no runtime output.",
        "```",
        "</details>",
      ].join("\n"),
    ]) {
      for (const rowId of ["backend-logs", "frontend-logs"]) {
        assert.strictEqual(
          auditPrEvidence(withEvidenceRow(rowId, invalidDetails)).findings.find(
            (finding) => finding.id === rowId,
          )?.status,
          "unsatisfied",
        );
      }
    }

    for (const rowId of [
      "before-screenshots",
      "after-screenshots",
      "walkthrough-video",
      "llm-trajectory",
      "domain-artifacts",
    ]) {
      assert.strictEqual(
        auditPrEvidence(withEvidenceRow(rowId, backendDetails)).findings.find(
          (finding) => finding.id === rowId,
        )?.status,
        "unsatisfied",
      );
    }
  });

  it("audits only invalid voluntary provenance and accepts unattributed claims", () => {
    const comments = [
      comment(1, "human", "Ordinary human discussion needs no footer."),
      comment(
        8,
        "policy-reviewer",
        "The `AI provider/model:` field in your comment is malformed.",
      ),
      comment(
        9,
        "quote-reviewer",
        "> AI provider/model: quoted / example\n\nThis is quoted policy text.",
      ),
      comment(
        10,
        "fence-reviewer",
        "```text\nAI provider/model: example / example-model\n```",
      ),
      comment(
        11,
        "fenced-claimer",
        "````text\nCLAIMING: policy example\n```\n````",
      ),
      comment(
        12,
        "indented-claimer",
        "    CLAIMING REVIEW: indented policy example",
      ),
      comment(
        2,
        "human-claimer",
        [
          "CLAIMING: documentation cleanup",
          "",
          "AI assistance: no - human-only claim",
          "Attribution status: self-reported",
        ].join("\n"),
      ),
      comment(3, "missing-claimer", "CLAIMING REVIEW: test coverage"),
      comment(
        4,
        "invalid-ai",
        "AI provider/model: unknown / model\nAttribution status: self-reported",
      ),
      comment(5, "valid-ai", "AI provider/model: OpenAI / gpt-5.6-codex"),
      comment(
        6,
        "nonterminal-human",
        [
          "CLAIMING LEVER: staging deployment",
          "AI assistance: no - human-only claim",
          "Attribution status: self-reported",
          "This text invalidates the terminal footer.",
        ].join("\n"),
      ),
      comment(
        7,
        "automation-bot",
        "CLAIMING: automated update without provenance",
        "Bot",
      ),
    ];

    assert.deepStrictEqual(
      auditCommentDisclosures(
        comments.map((value, index) => ({
          id: value.id,
          kind: "issue-comment",
          url: value.html_url,
          author: value.user.login,
          authorId: value.user.id,
          authorKnown: true,
          bot: value.user.type === "Bot",
          body: value.body ?? "",
          createdAt: value.created_at,
          index,
        })),
      ).map((finding) => finding.id),
      [4],
    );
  });

  it("classifies bot accounts and parses only supported CLI arguments", () => {
    assert.strictEqual(isBotAccount(account("dependabot[bot]", "Bot")), true);
    assert.strictEqual(isBotAccount(account("release-bot")), true);
    assert.strictEqual(isBotAccount(account("github-actions")), true);
    assert.strictEqual(isBotAccount(account("renovate")), true);
    assert.strictEqual(isBotAccount(account("octocat")), false);
    assert.deepStrictEqual(
      parseCliArguments(["--repo", "elizaOS/eliza", "--json"]),
      { repo: "elizaOS/eliza", json: true, help: false },
    );
    assert.throws(
      () => parseCliArguments(["--repo", "invalid"]),
      /owner\/name/,
    );
    assert.throws(() => parseCliArguments(["--write"]), /Unknown argument/);
  });
});

describe("live report behavior", () => {
  it("invokes gh only through 2.45-compatible paginated GET requests", () => {
    let invocation:
      | {
          command: string;
          args: string[];
          options: Record<string, unknown>;
        }
      | undefined;
    const pages = readGhPages(
      "repos/elizaOS/eliza/issues?state=open&per_page=100",
      (command, args, options) => {
        invocation = { command, args, options };
        return {
          status: 0,
          stdout: '{"number":1}\n{"number":2}\n',
          stderr: "",
        };
      },
    );

    assert.deepStrictEqual(pages, [{ number: 1 }, { number: 2 }]);
    assert.strictEqual(invocation?.command, "gh");
    assert.deepStrictEqual(invocation?.args, [
      "api",
      "--method",
      "GET",
      "--paginate",
      "--jq",
      ".[]",
      "repos/elizaOS/eliza/issues?state=open&per_page=100",
    ]);
    assert.deepStrictEqual(invocation?.options, {
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15_000,
      windowsHide: true,
    });
    assert.ok(
      !invocation?.args.some((argument) => /POST|PATCH|DELETE/.test(argument)),
    );
  });

  it("fails timed-out reads once with endpoint and attempt context", () => {
    const endpoint = "repos/elizaOS/eliza/issues/1/comments?per_page=100";
    const timeoutError = Object.assign(new Error("spawnSync gh ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    let invocations = 0;
    const delays: number[] = [];

    assert.throws(
      () =>
        readGhPages(
          endpoint,
          (_command, _args, options) => {
            invocations += 1;
            assert.strictEqual(options.timeout, 15_000);
            assert.strictEqual(options.killSignal, "SIGKILL");
            return {
              error: timeoutError,
              signal: "SIGKILL",
              status: null,
              stderr: "",
              stdout: '{"number":999,"partial":true}\n',
            };
          },
          (durationMs) => delays.push(durationMs),
        ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(`timed out for ${endpoint}`) &&
        error.message.includes("on attempt 1") &&
        error.message.includes("after 15000ms") &&
        error.message.includes("partial output was discarded") &&
        error.cause === timeoutError,
    );
    assert.strictEqual(invocations, 1);
    assert.deepStrictEqual(delays, []);
  });

  it("fails command and spawn errors with endpoint context", () => {
    const endpoint = "repos/elizaOS/eliza/issues?state=open&per_page=100";
    assert.throws(
      () =>
        readGhPages(endpoint, () => ({
          status: 1,
          stdout: '{"number":1}\n',
          stderr: "HTTP 502",
        })),
      /gh api failed for repos\/elizaOS\/eliza\/issues.*HTTP 502/,
    );
    const spawnError = new Error("spawn gh ENOENT");
    assert.throws(
      () =>
        readGhPages(endpoint, () => ({
          status: null,
          stdout: "",
          stderr: "",
          error: spawnError,
        })),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(`could not start for ${endpoint}`) &&
        error.cause === spawnError,
    );
  });

  it("retries transient reads without accepting partial output", () => {
    for (const transientFailure of [
      'Get "https://api.github.com/repos/elizaOS/eliza/issues": net/http: TLS handshake timeout',
      "gh: HTTP 503: Service Unavailable",
    ]) {
      const invocations: string[][] = [];
      const delays: number[] = [];
      const outcomes = [
        {
          status: 1,
          stdout: '{"number":999,"partial":true}\n',
          stderr: transientFailure,
        },
        {
          status: 0,
          stdout: '{"number":1}\n{"number":2}\n',
          stderr: "",
        },
      ];

      const pages = readGhPages(
        "repos/elizaOS/eliza/issues?state=open&per_page=100",
        (_command, args) => {
          invocations.push(args);
          const outcome = outcomes.shift();
          assert.ok(outcome);
          return outcome;
        },
        (durationMs) => delays.push(durationMs),
      );

      assert.deepStrictEqual(pages, [{ number: 1 }, { number: 2 }]);
      assert.deepStrictEqual(delays, [250]);
      assert.strictEqual(invocations.length, 2);
      assert.ok(
        invocations.every(
          (args) =>
            args[0] === "api" &&
            args[1] === "--method" &&
            args[2] === "GET" &&
            !args.some((argument) => /POST|PATCH|DELETE/.test(argument)),
        ),
      );
    }
  });

  it("bounds transient retries and reports the exhausted attempt count", () => {
    let invocations = 0;
    const delays: number[] = [];
    const endpoint = "repos/elizaOS/eliza/issues/1/comments?per_page=100";

    assert.throws(
      () =>
        readGhPages(
          endpoint,
          (_command, args) => {
            invocations += 1;
            assert.deepStrictEqual(args.slice(0, 6), [
              "api",
              "--method",
              "GET",
              "--paginate",
              "--jq",
              ".[]",
            ]);
            return {
              status: 1,
              stdout: "",
              stderr: "Get api.github.com: connection reset by peer",
            };
          },
          (durationMs) => delays.push(durationMs),
        ),
      /gh api failed for repos\/elizaOS\/eliza\/issues\/1\/comments\?per_page=100 after 3 attempts/,
    );
    assert.strictEqual(invocations, 3);
    assert.deepStrictEqual(delays, [250, 500]);
  });

  it("does not retry non-transient failures, spawn errors, or malformed output", () => {
    const endpoint = "repos/elizaOS/eliza/issues?state=open&per_page=100";
    for (const scenario of [
      {
        expected: /HTTP 401: Bad credentials/,
        result: {
          status: 1,
          stdout: "",
          stderr: "gh: HTTP 401: Bad credentials",
        },
      },
      {
        expected: /gh api could not start for/,
        result: {
          error: new Error("spawn gh ENOENT"),
          status: null,
          stdout: "",
          stderr: "",
        },
      },
      {
        expected: /malformed JSON .* at output line 2/,
        result: {
          status: 0,
          stdout: '{"number":1}\nnot-json\n',
          stderr: "",
        },
      },
    ]) {
      let invocations = 0;
      const delays: number[] = [];
      assert.throws(
        () =>
          readGhPages(
            endpoint,
            () => {
              invocations += 1;
              return scenario.result;
            },
            (durationMs) => delays.push(durationMs),
          ),
        scenario.expected,
      );
      assert.strictEqual(invocations, 1);
      assert.deepStrictEqual(delays, []);
    }
  });

  it("filters bots, sensitive or claimed work and audits disclosures and evidence", () => {
    const openIssues = [
      {
        number: 1,
        title: "Bot issue",
        html_url: "https://github.com/elizaOS/eliza/issues/1",
        user: account("dependabot[bot]", "Bot"),
        labels: [],
        assignees: [],
        comments: 0,
      },
      {
        number: 2,
        title: "Claimed issue",
        html_url: "https://github.com/elizaOS/eliza/issues/2",
        user: account("human-one"),
        labels: [{ name: "good first issue" }],
        assignees: [],
        comments: 1,
      },
      {
        number: 3,
        title: "Candidate issue",
        html_url: "https://github.com/elizaOS/eliza/issues/3",
        user: account("human-two"),
        labels: [{ name: "good first issue" }],
        assignees: [],
        comments: 1,
      },
      {
        number: 4,
        title: "Sensitive report",
        html_url: "https://github.com/elizaOS/eliza/issues/4",
        user: account("human-three"),
        labels: [{ name: "security" }],
        assignees: [],
        comments: 0,
      },
      {
        number: 5,
        title: "Lane-labeled claim",
        html_url: "https://github.com/elizaOS/eliza/issues/5",
        user: account("human-four"),
        labels: [{ name: "good first issue" }, { name: "claimed:shaw-codex" }],
        assignees: [],
        comments: 0,
      },
      {
        number: 6,
        title: "Blocked issue",
        html_url: "https://github.com/elizaOS/eliza/issues/6",
        user: account("human-five"),
        labels: [{ name: "good first issue" }, { name: "status: blocked" }],
        assignees: [],
        comments: 0,
      },
      {
        number: 7,
        title: "Ghost-authored issue",
        html_url: "https://github.com/elizaOS/eliza/issues/7",
        user: null,
        labels: [],
        assignees: [],
        comments: 0,
      },
      {
        number: 8,
        title: "Needs maintainer triage",
        html_url: "https://github.com/elizaOS/eliza/issues/8",
        user: account("human-six"),
        labels: [],
        assignees: [],
        comments: 0,
      },
      {
        number: 9,
        title: "[Epic] Replace the whole contribution pipeline",
        html_url: "https://github.com/elizaOS/eliza/issues/9",
        user: account("human-seven"),
        labels: [{ name: "triage-reviewed" }],
        assignees: [],
        comments: 0,
      },
      {
        number: 19,
        title: "Decision reserved for a maintainer",
        html_url: "https://github.com/elizaOS/eliza/issues/19",
        user: account("human-eight"),
        labels: [
          { name: "triage-reviewed" },
          { name: "needs-human-verification" },
        ],
        assignees: [],
        comments: 0,
      },
      {
        number: 20,
        title: "Replace the whole contribution pipeline",
        html_url: "https://github.com/elizaOS/eliza/issues/20",
        user: account("human-nine"),
        labels: [{ name: "triage-reviewed" }, { name: "Epic 4" }],
        assignees: [],
        comments: 0,
      },
      {
        number: 21,
        title: "Proposal awaiting a decision",
        html_url: "https://github.com/elizaOS/eliza/issues/21",
        user: account("human-ten"),
        labels: [{ name: "triage-reviewed" }, { name: "status/proposal" }],
        assignees: [],
        comments: 0,
      },
      {
        number: 10,
        title: "PR shadow from issues endpoint",
        html_url: "https://github.com/elizaOS/eliza/pull/10",
        user: account("author"),
        labels: [],
        assignees: [],
        comments: 0,
        pull_request: {},
      },
    ];
    const openPulls = [
      pullRequest(10, { title: "Ready PR", user: account("author") }),
      pullRequest(11, {
        title: "Draft PR",
        user: account("draft-author"),
        draft: true,
        body: null,
      }),
      pullRequest(12, {
        title: "Claimed review",
        user: account("review-author"),
      }),
      pullRequest(13, {
        title: "Bot PR",
        user: account("renovate[bot]", "Bot"),
      }),
      pullRequest(14, {
        title: "Human-only PR",
        user: account("human-author"),
        body: evidenceBody().replace(
          "AI provider/model: OpenAI / gpt-5.6-codex",
          "- AI assistance: no - human-only contribution",
        ),
      }),
      pullRequest(15, {
        title: "Sensitive pull request",
        labels: [{ name: "credential-leak" }],
      }),
      pullRequest(16, {
        title: "Assigned review",
        assignees: [account("assigned-reviewer")],
      }),
      pullRequest(17, {
        title: "Lane-labeled review",
        labels: [{ name: "review-claimed:review-lane" }],
      }),
      pullRequest(18, {
        title: "Ghost-authored pull request",
        user: null,
      }),
    ];
    const calls: string[] = [];
    const responses = new Map<string, unknown[]>([
      [
        "repos/elizaOS/eliza/issues?state=open&per_page=100&sort=created&direction=asc",
        openIssues,
      ],
      [
        "repos/elizaOS/eliza/pulls?state=open&per_page=100&sort=created&direction=asc",
        openPulls,
      ],
      [
        "repos/elizaOS/eliza/issues/2/comments?per_page=100",
        [
          comment(
            20,
            "worker",
            "CLAIMING: scoped fix\n\nAI provider/model: OpenAI / gpt-5.6-codex",
          ),
        ],
      ],
      [
        "repos/elizaOS/eliza/issues/3/comments?per_page=100",
        [
          comment(
            30,
            "visitor",
            "Can reproduce this.\n\n~~~text\nCLAIMING: policy example only\n~~~",
          ),
        ],
      ],
      ["repos/elizaOS/eliza/issues/10/comments?per_page=100", []],
      ["repos/elizaOS/eliza/pulls/10/comments?per_page=100", []],
      ["repos/elizaOS/eliza/pulls/10/reviews?per_page=100", []],
      ["repos/elizaOS/eliza/issues/11/comments?per_page=100", []],
      ["repos/elizaOS/eliza/pulls/11/comments?per_page=100", []],
      ["repos/elizaOS/eliza/pulls/11/reviews?per_page=100", []],
      [
        "repos/elizaOS/eliza/issues/12/comments?per_page=100",
        [
          comment(
            120,
            "reviewer",
            "CLAIMING REVIEW: tests and evidence\n\nAI provider/model: Anthropic / claude-opus-4.1",
          ),
        ],
      ],
      ["repos/elizaOS/eliza/pulls/12/comments?per_page=100", []],
      ["repos/elizaOS/eliza/pulls/12/reviews?per_page=100", []],
      ["repos/elizaOS/eliza/issues/14/comments?per_page=100", []],
      ["repos/elizaOS/eliza/pulls/14/comments?per_page=100", []],
      ["repos/elizaOS/eliza/pulls/14/reviews?per_page=100", []],
      ["repos/elizaOS/eliza/issues/16/comments?per_page=100", []],
      ["repos/elizaOS/eliza/pulls/16/comments?per_page=100", []],
      ["repos/elizaOS/eliza/pulls/16/reviews?per_page=100", []],
      ["repos/elizaOS/eliza/issues/17/comments?per_page=100", []],
      ["repos/elizaOS/eliza/pulls/17/comments?per_page=100", []],
      ["repos/elizaOS/eliza/pulls/17/reviews?per_page=100", []],
    ]);

    const report = collectLiveReport(
      "elizaOS/eliza",
      (endpoint) => {
        calls.push(endpoint);
        const response = responses.get(endpoint);
        assert.ok(response, `unexpected endpoint: ${endpoint}`);
        return response;
      },
      NOW,
    );

    assert.deepStrictEqual(
      report.candidateIssues.map((issue) => issue.number),
      [3],
    );
    assert.deepStrictEqual(
      report.reviewablePullRequests.map((pull) => pull.number),
      [10, 14],
    );
    assert.deepStrictEqual(
      report.filtered.botIssues.map((issue) => issue.number),
      [1],
    );
    assert.deepStrictEqual(
      report.filtered.unknownAuthorIssues.map((issue) => issue.number),
      [7],
    );
    assert.deepStrictEqual(
      report.filtered.sensitiveIssues.map((issue) => issue.number),
      [4],
    );
    assert.deepStrictEqual(
      report.filtered.untriagedIssues.map((issue) => issue.number),
      [8, 9, 20],
    );
    assert.deepStrictEqual(
      report.filtered.claimedIssues.map((issue) => issue.number),
      [2, 5, 6, 19, 21],
    );
    assert.deepStrictEqual(
      report.filtered.draftPullRequests.map((pull) => pull.number),
      [11],
    );
    assert.deepStrictEqual(
      report.filtered.claimedPullRequests.map((pull) => pull.number),
      [12, 16, 17],
    );
    assert.deepStrictEqual(
      report.filtered.sensitivePullRequests.map((pull) => pull.number),
      [15],
    );
    assert.deepStrictEqual(
      report.filtered.botPullRequests.map((pull) => pull.number),
      [13],
    );
    assert.deepStrictEqual(
      report.filtered.unknownAuthorPullRequests.map((pull) => pull.number),
      [18],
    );
    assert.deepStrictEqual(
      report.audits.issueComments.map((issue) => issue.number),
      [],
    );
    assert.strictEqual(
      report.audits.pullRequests.find((pull) => pull.number === 10)?.evidence
        .ok,
      true,
    );
    assert.strictEqual(
      report.audits.pullRequests.find((pull) => pull.number === 11)
        ?.bodyProviderModel,
      null,
    );
    assert.strictEqual(
      report.audits.pullRequests.find((pull) => pull.number === 14)
        ?.bodyHumanOnly,
      true,
    );
    assert.ok(
      !calls.some((endpoint) => endpoint.includes("/13/")),
      "bot-authored PR detail endpoints should not be read",
    );
    assert.ok(
      !calls.some((endpoint) => endpoint.includes("/15/")),
      "security-sensitive PR detail endpoints should not be read",
    );
    assert.strictEqual(renderMarkdown(report), renderMarkdown(report));
    assert.match(
      renderMarkdown(report),
      /PR \[#11\].*lacks exact provider\/model/,
    );
    assert.doesNotMatch(
      renderMarkdown(report),
      /PR \[#14\].*lacks exact provider\/model/,
    );
  });

  it("expires comment claims after seven days but preserves durable issue state", () => {
    assert.strictEqual(CLAIM_RECENCY_DAYS, 7);
    const issues = [
      {
        number: 20,
        title: "Recent comment claim",
        html_url: "https://github.com/elizaOS/eliza/issues/20",
        user: account("author-20"),
        labels: [{ name: "help wanted" }],
        assignees: [],
        comments: 1,
      },
      {
        number: 21,
        title: "Expired comment claim",
        html_url: "https://github.com/elizaOS/eliza/issues/21",
        user: account("author-21"),
        labels: [{ name: "help wanted" }],
        assignees: [],
        comments: 1,
      },
      {
        number: 22,
        title: "Durably assigned",
        html_url: "https://github.com/elizaOS/eliza/issues/22",
        user: account("author-22"),
        labels: [{ name: "help wanted" }],
        assignees: [account("maintainer")],
        comments: 1,
      },
      {
        number: 23,
        title: "Durably labeled",
        html_url: "https://github.com/elizaOS/eliza/issues/23",
        user: account("author-23"),
        labels: [{ name: "help wanted" }, { name: "  status: in-progress  " }],
        assignees: [],
        comments: 1,
      },
      {
        number: 24,
        title: "Untrusted public claim",
        html_url: "https://github.com/elizaOS/eliza/issues/24",
        user: account("author-24"),
        labels: [{ name: "help wanted" }],
        assignees: [],
        comments: 1,
      },
    ];
    const comments = new Map([
      [
        20,
        [
          comment(
            200,
            "worker",
            "CLAIMING: recent work",
            "User",
            "2026-01-14T12:00:01.000Z",
          ),
        ],
      ],
      [
        21,
        [
          comment(
            210,
            "worker",
            "CLAIMING: abandoned work",
            "User",
            "2026-01-13T11:59:59.000Z",
          ),
        ],
      ],
      [
        22,
        [
          comment(
            220,
            "worker",
            "CLAIMING: abandoned work",
            "User",
            "2026-01-01T00:00:00.000Z",
          ),
        ],
      ],
      [
        23,
        [
          comment(
            230,
            "worker",
            "CLAIMING: abandoned work",
            "User",
            "2026-01-01T00:00:00.000Z",
          ),
        ],
      ],
      [
        24,
        [
          comment(
            240,
            "outside-visitor",
            "CLAIMING: cannot reserve work without repository trust",
            "User",
            "2026-01-18T12:00:00.000Z",
            "NONE",
          ),
        ],
      ],
    ]);
    const report = collectLiveReport(
      "elizaOS/eliza",
      (endpoint) => {
        if (endpoint.includes("/issues?state=open")) return issues;
        if (endpoint.includes("/pulls?state=open")) return [];
        const number = Number(endpoint.match(/issues\/(\d+)\/comments/)?.[1]);
        const response = comments.get(number);
        assert.ok(response, `unexpected endpoint: ${endpoint}`);
        return response;
      },
      NOW,
    );

    assert.deepStrictEqual(
      report.candidateIssues.map((issue) => issue.number),
      [21, 24],
    );
    assert.deepStrictEqual(
      report.filtered.claimedIssues.map((issue) => issue.number),
      [20, 22, 23],
    );
    assert.match(
      report.filtered.claimedIssues
        .find((issue) => issue.number === 22)
        ?.claimReasons.join(" "),
      /assignees: maintainer/,
    );
    assert.match(
      report.filtered.claimedIssues
        .find((issue) => issue.number === 23)
        ?.claimReasons.join(" "),
      /labels: status: in-progress/,
    );
  });

  it("treats live review requests as durable and uses current-head review state", () => {
    const pulls = [
      pullRequest(30, {
        requested_reviewers: [account("recent-reviewer")],
      }),
      pullRequest(31, {
        requested_reviewers: [account("stale-reviewer")],
      }),
      pullRequest(32),
      pullRequest(33),
      pullRequest(34),
      pullRequest(35, {
        requested_teams: [{ slug: "core-maintainers" }],
      }),
      pullRequest(36),
      pullRequest(37),
      pullRequest(38, {
        requested_reviewers: [account("automation-bot", "Bot")],
      }),
      pullRequest(39, {
        requested_reviewers: [account("recent-fallback")],
      }),
      pullRequest(40, {
        requested_reviewers: [account("stale-fallback")],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      }),
      pullRequest(41),
      pullRequest(42),
      pullRequest(43),
      pullRequest(45),
      pullRequest(46),
      pullRequest(47),
      pullRequest(48),
      pullRequest(49, {
        assignees: [account("AUTHOR-49")],
      }),
      pullRequest(50),
      pullRequest(51),
      pullRequest(52),
      pullRequest(53),
    ];
    const issueComments = new Map<number, ReturnType<typeof comment>[]>([
      [
        36,
        [
          comment(
            360,
            "old-reviewer",
            "CLAIMING REVIEW: abandoned review",
            "User",
            "2026-01-01T00:00:00.000Z",
          ),
        ],
      ],
      [
        37,
        [
          comment(
            370,
            "active-reviewer",
            "CLAIMING REVIEW: current review",
            "User",
            "2026-01-18T00:00:00.000Z",
          ),
        ],
      ],
      [
        47,
        [
          comment(
            470,
            "AUTHOR-47",
            "CLAIMING REVIEW: self-review does not reserve the independent lane",
          ),
        ],
      ],
      [48, [comment(480, "empty-marker", "CLAIMING REVIEW:")]],
      [
        51,
        [
          {
            ...comment(
              510,
              "deleted-reviewer",
              "CLAIMING REVIEW: deleted authors cannot reserve work",
            ),
            user: null,
          },
        ],
      ],
      [
        52,
        [
          comment(
            520,
            "spaced-marker",
            "CLAIMING REVIEW : noncanonical marker",
          ),
        ],
      ],
    ]);
    const reviews = new Map<number, ReturnType<typeof review>[]>([
      [32, [review(320, "approver", "APPROVED")]],
      [33, [review(330, "requester", "CHANGES_REQUESTED")]],
      [34, [review(340, "past-reviewer", "APPROVED", PRIOR_SHA)]],
      [41, [review(410, null, "APPROVED")]],
      [
        42,
        [
          review(420, "tied-reviewer", "APPROVED"),
          review(421, "tied-reviewer", "CHANGES_REQUESTED"),
        ],
      ],
      [
        43,
        [
          {
            ...review(430, "github-actions", "CHANGES_REQUESTED"),
            user: account("github-actions"),
          },
        ],
      ],
      [
        45,
        [
          review(
            450,
            "commenting-reviewer",
            "CHANGES_REQUESTED",
            HEAD_SHA,
            "2026-01-18T12:00:00.000Z",
          ),
          review(
            451,
            "commenting-reviewer",
            "COMMENTED",
            HEAD_SHA,
            "2026-01-18T13:00:00.000Z",
          ),
        ],
      ],
      [
        46,
        [
          review(
            460,
            "dismissed-reviewer",
            "CHANGES_REQUESTED",
            HEAD_SHA,
            "2026-01-18T12:00:00.000Z",
          ),
          review(
            461,
            "dismissed-reviewer",
            "DISMISSED",
            HEAD_SHA,
            "2026-01-18T13:00:00.000Z",
          ),
        ],
      ],
      [
        53,
        [
          review(
            530,
            null,
            "CHANGES_REQUESTED",
            HEAD_SHA,
            "2026-01-18T12:00:00.000Z",
          ),
          review(531, null, "APPROVED", HEAD_SHA, "2026-01-18T13:00:00.000Z"),
        ],
      ],
    ]);
    const inlineComments = new Map<number, ReturnType<typeof comment>[]>([
      [
        50,
        [
          comment(
            500,
            "inline-reviewer",
            "CLAIMING REVIEW: inspecting this exact code path",
          ),
        ],
      ],
    ]);
    const report = collectLiveReport(
      "elizaOS/eliza",
      (endpoint) => {
        if (endpoint.includes("/issues?state=open")) return [];
        if (endpoint.includes("/pulls?state=open")) return pulls;
        const issueComment = endpoint.match(/issues\/(\d+)\/comments/);
        if (issueComment) {
          return issueComments.get(Number(issueComment[1])) ?? [];
        }
        const inlineComment = endpoint.match(/pulls\/(\d+)\/comments/);
        if (inlineComment) {
          return inlineComments.get(Number(inlineComment[1])) ?? [];
        }
        const reviewList = endpoint.match(/pulls\/(\d+)\/reviews/);
        if (reviewList) return reviews.get(Number(reviewList[1])) ?? [];
        assert.fail(`unexpected endpoint: ${endpoint}`);
      },
      NOW,
    );

    assert.deepStrictEqual(
      report.reviewablePullRequests.map((pull) => pull.number),
      [34, 36, 43, 46, 47, 48, 49, 51, 52],
    );
    assert.deepStrictEqual(
      report.filtered.claimedPullRequests.map((pull) => pull.number),
      [30, 31, 35, 37, 38, 39, 40, 50],
    );
    assert.deepStrictEqual(
      report.filtered.reviewedPullRequests.map((pull) => pull.number),
      [32, 41],
    );
    assert.deepStrictEqual(
      report.filtered.changesRequestedPullRequests.map((pull) => pull.number),
      [33, 42, 45, 53],
    );
    assert.deepStrictEqual(
      report.filtered.claimedPullRequests.find((pull) => pull.number === 31)
        ?.reviewState.activeRequests,
      ["stale-reviewer"],
    );
    assert.deepStrictEqual(
      report.reviewablePullRequests.find((pull) => pull.number === 34)
        ?.reviewState.currentHeadApprovals,
      [],
    );
    assert.doesNotMatch(renderMarkdown(report), /#31/);
    assert.match(renderMarkdown(report), /Claim comments expire after 7 days/);
    assert.match(
      renderMarkdown(report),
      /review requests persist until cleared/,
    );
  });

  it("rejects malformed review commit revisions", () => {
    assert.throws(
      () =>
        collectLiveReport(
          "elizaOS/eliza",
          (endpoint) => {
            if (endpoint.includes("/issues?state=open")) return [];
            if (endpoint.includes("/pulls?state=open")) {
              return [pullRequest(44)];
            }
            if (endpoint.includes("/issues/44/comments")) return [];
            if (endpoint.includes("/pulls/44/comments")) return [];
            if (endpoint.includes("/pulls/44/reviews")) {
              return [review(440, "reviewer", "APPROVED", "short-sha")];
            }
            assert.fail(`unexpected endpoint: ${endpoint}`);
          },
          NOW,
        ),
      /commit_id must be a full commit SHA or null/,
    );
  });

  it("rejects decision reviews without current-head provenance", () => {
    const incompleteReviews = [
      { ...review(450, "reviewer", "APPROVED"), commit_id: null },
      { ...review(451, "reviewer", "CHANGES_REQUESTED"), submitted_at: null },
    ];
    for (const incompleteReview of incompleteReviews) {
      assert.throws(
        () =>
          collectLiveReport(
            "elizaOS/eliza",
            (endpoint) => {
              if (endpoint.includes("/issues?state=open")) return [];
              if (endpoint.includes("/pulls?state=open")) {
                return [pullRequest(45)];
              }
              if (endpoint.includes("/issues/45/comments")) return [];
              if (endpoint.includes("/pulls/45/comments")) return [];
              if (endpoint.includes("/pulls/45/reviews")) {
                return [incompleteReview];
              }
              assert.fail(`unexpected endpoint: ${endpoint}`);
            },
            NOW,
          ),
        /cannot prove a current-head (?:APPROVED|CHANGES_REQUESTED) decision/,
      );
    }
  });
});
