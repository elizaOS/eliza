/**
 * Exercises attribution enforcement for machine and human contribution claims
 * without imposing provenance syntax on ordinary project conversation.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { evaluateCommentAttribution } from "./check-agent-comment-attribution.mjs";

function machineFooter(overrides = {}) {
  const values = {
    provider: "OpenRouter",
    providerSlug: "openrouter",
    model: "anthropic/claude-sonnet-4",
    client: "Codex desktop",
    lane: "qa-agent",
    skillRevision:
      "elizaOS/eliza@0123456789abcdef0123456789abcdef01234567:packages/skills/skills/contribute-to-eliza",
    ...overrides,
  };
  const marker = {
    provider: values.providerSlug,
    model: values.model,
    client: values.client,
    skill_revision: values.skillRevision,
  };
  return `AI provider/model: ${values.provider} / ${values.model}
Client / agent tooling: ${values.client}
Contribution skill revision: ${values.skillRevision}
Attribution status: self-reported
— [${values.lane}]
<!-- eliza-computer-attribution:v1 ${JSON.stringify(marker)} -->`;
}

function workflowMachineFooter(path) {
  const workflow = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const matches = [
    ...workflow.matchAll(
      /AI provider\/model:[^\n]*\n[\s\S]*?<!--\s*eliza-computer-attribution:v1\s+\{[^\n]*\}\s*-->/g,
    ),
  ];
  assert.ok(matches.length > 0, `${path} must contain a machine footer`);
  return matches
    .at(-1)[0]
    .split(/\r?\n/)
    .map((line) => line.trimStart())
    .join("\n");
}

function filledHumanIssueTemplate(path, noun) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
    .replace(
      /^- AI assistance:.*$/m,
      `- AI assistance: no - human-only ${noun}`,
    )
    .replace(
      /^- AI provider\/model:.*$/m,
      `- AI provider/model: N/A - human-only ${noun}`,
    )
    .replace(
      /^- Client \/ agent tooling:.*$/m,
      `- Client / agent tooling: N/A - human-only ${noun}`,
    )
    .replace(
      /^- Contribution skill revision:.*$/m,
      "- Contribution skill revision: N/A - no contribution skill used",
    )
    .replace(
      /^- Attribution status:.*$/m,
      "- Attribution status: self-reported",
    );
}

describe("agent comment attribution", () => {
  it("accepts an exact nested model identifier on a claim", () => {
    const result = evaluateCommentAttribution(
      `CLAIMING REVIEW: verify the data boundary\n\n${machineFooter()}`,
    );
    assert.equal(result.ok, true);
    assert.equal(result.attribution.model, "anthropic/claude-sonnet-4");
  });

  it("accepts the automated skill-review footer emitted by repository CI", () => {
    const skillRevision =
      "N/A - automated SKILL.md review does not invoke the contribution skill";
    const result = evaluateCommentAttribution(
      `Blocking finding at SKILL.md:42.

AI provider/model: Anthropic / claude-sonnet-4-6
Client / agent tooling: claude-code-action
Contribution skill revision: ${skillRevision}
Attribution status: self-reported
— [skill-review-agent]
<!-- eliza-computer-attribution:v1 {"provider":"anthropic","model":"claude-sonnet-4-6","client":"claude-code-action","skill_revision":"${skillRevision}"} -->`,
    );
    assert.equal(result.ok, true);
    assert.equal(result.attribution.client, "claude-code-action");
  });

  it("requires attribution on implementation, review, and lever claims", () => {
    for (const claim of [
      "CLAIMING: issue scope",
      "CLAIMING REVIEW: PR scope",
      "CLAIMING LEVER: production deploy",
    ]) {
      const result = evaluateCommentAttribution(claim);
      assert.equal(result.ok, false);
      assert.ok(result.findings.some((finding) => finding.id === "marker"));
    }
  });

  it("requires one machine lane signature immediately before the marker", () => {
    const missing = evaluateCommentAttribution(
      machineFooter().replace("— [qa-agent]\n", ""),
      { required: true },
    );
    assert.equal(missing.ok, false);
    assert.ok(missing.findings.some((finding) => finding.id === "lane-tag"));

    const duplicate = evaluateCommentAttribution(
      machineFooter().replace("— [qa-agent]", "— [core-agent]\n— [qa-agent]"),
      { required: true },
    );
    assert.equal(duplicate.ok, false);
    assert.ok(duplicate.findings.some((finding) => finding.id === "lane-tag"));
  });

  it("rejects lane signatures inside fences or followed by prose", () => {
    const fenced = evaluateCommentAttribution(
      machineFooter().replace("— [qa-agent]", "```text\n— [qa-agent]\n```"),
      { required: true },
    );
    assert.equal(fenced.ok, false);
    assert.ok(fenced.findings.some((finding) => finding.id === "lane-tag"));

    const nonterminal = evaluateCommentAttribution(
      machineFooter().replace(
        "— [qa-agent]\n<!--",
        "— [qa-agent]\nThis prose breaks the terminal signature.\n<!--",
      ),
      { required: true },
    );
    assert.equal(nonterminal.ok, false);
    assert.ok(
      nonterminal.findings.some((finding) => finding.id === "lane-tag"),
    );
  });

  it("accepts an explicit terminal human-only claim footer", () => {
    const result = evaluateCommentAttribution(`CLAIMING: documentation cleanup

AI assistance: no - human-only claim
Attribution status: self-reported`);
    assert.equal(result.ok, true);
    assert.equal(result.attribution.kind, "human-only");
  });

  it("does not impose attribution syntax on ordinary human discussion", () => {
    const result = evaluateCommentAttribution(
      "I reproduced this on macOS and added the logs above.",
    );
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
  });

  it("accepts matching no-AI issue rows and rejects mixed reasons", () => {
    const issue = `## Contribution provenance

- AI assistance: no - human-only report
- AI provider/model: N/A - human-only report
- Client / agent tooling: N/A - human-only report
- Contribution skill revision: N/A - no contribution skill used
- Attribution status: self-reported`;
    const accepted = evaluateCommentAttribution(issue, { issueBody: true });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.attribution.kind, "no-ai");

    const mixed = evaluateCommentAttribution(
      issue.replace(
        "Client / agent tooling: N/A - human-only report",
        "Client / agent tooling: None - deterministic workflow",
      ),
      { issueBody: true },
    );
    assert.equal(mixed.ok, false);
    assert.ok(mixed.findings.some((finding) => finding.id === "no-ai-reason"));

    const markerConflict = evaluateCommentAttribution(
      `${issue}\n<!-- eliza-computer-attribution:v1 -->`,
      { issueBody: true },
    );
    assert.equal(markerConflict.ok, false);
    assert.ok(
      markerConflict.findings.some(
        (finding) => finding.id === "human-only-conflict",
      ),
    );
  });

  it("keeps every issue template valid when filled as human-only", () => {
    for (const [path, noun] of [
      [".github/ISSUE_TEMPLATE/agent_work_item.md", "issue"],
      [".github/ISSUE_TEMPLATE/bug_report.md", "report"],
      [".github/ISSUE_TEMPLATE/epic.md", "epic"],
      [".github/ISSUE_TEMPLATE/feature_request.md", "request"],
    ]) {
      const result = evaluateCommentAttribution(
        filledHumanIssueTemplate(path, noun),
        { issueBody: true },
      );
      assert.equal(
        result.ok,
        true,
        `${path}: ${result.findings.map((finding) => finding.message).join("; ")}`,
      );
    }
  });

  it("validates a machine-assisted issue body with a terminal signed footer", () => {
    const issue = `## Scope

Review the contribution queue.

- AI assistance: yes
${machineFooter()}`;
    const result = evaluateCommentAttribution(issue, { issueBody: true });
    assert.equal(result.ok, true);
    assert.equal(result.attribution.model, "anthropic/claude-sonnet-4");
  });

  it("rejects marker mismatches, extra fields, and trailing content", () => {
    const mismatched = evaluateCommentAttribution(
      `${machineFooter({ providerSlug: "openai" })}\ntrailing text`,
      { required: true },
    );
    assert.equal(mismatched.ok, false);
    assert.ok(
      mismatched.findings.some((finding) => finding.id === "marker-provider"),
    );
    assert.ok(
      mismatched.findings.some((finding) => finding.id === "marker-position"),
    );

    const extra = machineFooter().replace(
      '"skill_revision":',
      '"session_id":"private","skill_revision":',
    );
    const extraResult = evaluateCommentAttribution(extra, { required: true });
    assert.equal(extraResult.ok, false);
    assert.ok(
      extraResult.findings.some((finding) => finding.id === "marker-fields"),
    );

    const malformedExtra = evaluateCommentAttribution(
      `<!-- eliza-computer-attribution:v1 -->\n${machineFooter()}`,
      { required: true },
    );
    assert.equal(malformedExtra.ok, false);
    assert.ok(
      malformedExtra.findings.some((finding) => finding.id === "marker"),
    );
  });

  it("rejects incomplete or conflicting human-only declarations", () => {
    assert.equal(
      evaluateCommentAttribution("CLAIMING: work\n\nhuman-only").ok,
      false,
    );
    const conflicting = evaluateCommentAttribution(
      `${machineFooter()}\nAI assistance: no - human-only claim\nAttribution status: self-reported`,
    );
    assert.equal(conflicting.ok, false);
  });

  it("rejects prose in place of an exact runtime model identifier", () => {
    const result = evaluateCommentAttribution(
      `CLAIMING: implementation\n\n${machineFooter({
        model: "ChatGPT Five Thinking",
      })}`,
    );
    assert.equal(result.ok, false);
    assert.ok(
      result.findings.some((finding) => finding.id === "provider-model"),
    );

    const genericProvider = evaluateCommentAttribution(
      machineFooter({ provider: "AI", providerSlug: "ai" }),
      { required: true },
    );
    assert.equal(genericProvider.ok, false);
    assert.ok(
      genericProvider.findings.some(
        (finding) => finding.id === "provider-model",
      ),
    );
  });

  it("does not skip alternate declarations of AI assistance or models used", () => {
    for (const body of [
      "AI assistance: yes\nImplementation was generated.",
      "Model used: gpt-5\nImplementation was generated.",
      "Model(s) used: claude-sonnet-4-6\nImplementation was generated.",
    ]) {
      const result = evaluateCommentAttribution(body);
      assert.equal(result.skipped, false, body);
      assert.equal(result.ok, false, body);
      assert.ok(
        result.findings.some((finding) => finding.id === "provider-model"),
        body,
      );
    }
  });

  it("keeps every AI-authored GitHub workflow compatible with the gate", () => {
    for (const path of [
      ".github/workflows/claude.yml",
      ".github/workflows/skill-review.yml",
      ".github/workflows/weekly-maintenance.yml",
    ]) {
      const result = evaluateCommentAttribution(workflowMachineFooter(path), {
        required: true,
      });
      assert.equal(
        result.ok,
        true,
        `${path}: ${result.findings.map((finding) => finding.message).join("; ")}`,
      );
    }
  });

  it("loads the comment validator only from the trusted default branch", () => {
    const workflow = readFileSync(
      new URL(
        "../.github/workflows/contribution-comment-attribution.yml",
        import.meta.url,
      ),
      "utf8",
    );
    assert.match(
      workflow,
      /uses:\s*actions\/checkout@[0-9a-f]{40}[\s\S]*?\n\s+ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/,
    );
    assert.match(workflow, /\n\s{2}discussion_comment:\s*\n/);
    assert.match(workflow, /\n\s{2}issues:\s*\n/);
  });
});
