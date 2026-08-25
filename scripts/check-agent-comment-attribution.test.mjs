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

function receiptFooter(overrides = {}, markerOverrides = {}) {
  const values = {
    provider: "Anthropic",
    providerSlug: "anthropic",
    model: "claude-opus-5",
    client: "Claude Code",
    lane: "qa-agent",
    skillRevision:
      "elizaOS/army@9259107132edeab02d9e47dbb7ce383721bada77:skills/contribute-to-eliza",
    ...overrides,
  };
  const marker = {
    provider: values.providerSlug,
    model: values.model,
    client: values.client,
    skill_revision: values.skillRevision,
    run: {
      schema_version: "1",
      run_id: "0f2c",
      usage: { total_tokens: 1234 },
      signature_algorithm: "ed25519",
      device_signature: "abc123",
    },
    ...markerOverrides,
  };
  return `AI provider/model: ${values.provider} / ${values.model}
Client / agent tooling: ${values.client}
Contribution skill revision: ${values.skillRevision}
Compute receipt: 1234 project-attributed tokens (exact; device-signed, locally reported)
Attribution status: self-reported
— [${values.lane}]
<!-- elizaos-contribution-attribution:v2 ${JSON.stringify(marker)} -->`;
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

  it("accepts implementation, review, and lever claims without attribution", () => {
    for (const claim of [
      "CLAIMING: issue scope",
      "CLAIMING REVIEW: PR scope",
      "CLAIMING LEVER: production deploy",
    ]) {
      const result = evaluateCommentAttribution(claim);
      assert.equal(result.ok, true);
      assert.equal(result.skipped, true);
      assert.equal(result.attribution, null);
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
    for (const discussion of [
      "I reproduced this on macOS and added the logs above.",
      "The `AI provider/model:` field in your comment is malformed.",
      "> AI provider/model: quoted / example\n\nThis is quoted policy text.",
      "```text\nAI provider/model: example / example-model\n```",
      "````text\nCLAIMING: example only\n```\nAI provider/model: example / example-model\n````",
      "    CLAIMING REVIEW: indented code is policy text",
    ]) {
      const result = evaluateCommentAttribution(discussion);
      assert.equal(result.ok, true, discussion);
      assert.equal(result.skipped, true, discussion);
    }
  });

  it("ignores quoted and fenced footer markers without weakening a real footer", () => {
    const quotedMarker =
      '> <!-- eliza-computer-attribution:v1 {"provider":"fake"} -->';
    const fencedMarker =
      '~~~text\n<!-- eliza-computer-attribution:v1 {"provider":"fake"} -->\n~~~';
    const fencedLane = "````text\n— [example-agent]\n```\n````";
    for (const prefix of [quotedMarker, fencedMarker, fencedLane]) {
      const result = evaluateCommentAttribution(
        `${prefix}\n\n${machineFooter()}`,
        { required: true },
      );
      assert.equal(
        result.ok,
        true,
        `${prefix}: ${result.findings.map((finding) => finding.message).join("; ")}`,
      );
    }
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

    for (const exampleMarker of [
      "> <!-- eliza-computer-attribution:v1 -->",
      "```text\n<!-- eliza-computer-attribution:v1 -->\n```",
    ]) {
      const example = evaluateCommentAttribution(
        `${exampleMarker}\n\n${issue}`,
        { issueBody: true },
      );
      assert.equal(
        example.ok,
        true,
        example.findings.map((finding) => finding.message).join("; "),
      );
    }
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

  it("accepts every issue template without an attribution default", () => {
    for (const path of [
      ".github/ISSUE_TEMPLATE/agent_work_item.md",
      ".github/ISSUE_TEMPLATE/bug_report.md",
      ".github/ISSUE_TEMPLATE/epic.md",
      ".github/ISSUE_TEMPLATE/feature_request.md",
    ]) {
      const body = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
      const result = evaluateCommentAttribution(body, { issueBody: true });
      assert.equal(
        result.ok,
        true,
        `${path}: ${result.findings.map((finding) => finding.message).join("; ")}`,
      );
      assert.equal(result.skipped, true, path);
      assert.equal(result.attribution, null, path);
    }
  });

  it("accepts pristine, absent, and explicitly required issue attribution", () => {
    const pristine = evaluateCommentAttribution(
      `## Contribution provenance

- AI assistance: \`yes\` / \`no - human-only report\`
- AI provider/model: \`<provider> / <exact-model-id>\` / \`N/A - human-only report\`
- Client / agent tooling: \`<client-name>\` / \`N/A - human-only report\`
- Contribution skill revision: \`owner/repo@full-commit-sha:path\` / \`N/A - no contribution skill used\`
- Attribution status: \`self-reported\`

**Describe the bug**

The button does nothing.`,
      { issueBody: true },
    );
    assert.equal(pristine.ok, true);
    assert.equal(pristine.skipped, true);
    assert.equal(pristine.notice, undefined);

    const absent = evaluateCommentAttribution(
      "The app crashes on launch. Logs attached.",
      { issueBody: true },
    );
    assert.equal(absent.ok, true);
    assert.equal(absent.skipped, true);
    assert.equal(absent.notice, undefined);

    // Claims and the legacy required option cannot force a disclosure. An
    // author-supplied malformed attribution signal is still validated.
    const claimed = evaluateCommentAttribution(
      "CLAIMING: fix the crash\n\nNo footer here.",
      { issueBody: true },
    );
    assert.equal(claimed.ok, true);
    assert.equal(claimed.skipped, true);

    const edited = evaluateCommentAttribution(
      `- AI assistance: yes
- AI provider/model: \`<provider> / <exact-model-id>\` / \`N/A - human-only report\`
- Attribution status: \`self-reported\``,
      { issueBody: true },
    );
    assert.equal(edited.ok, false);

    const required = evaluateCommentAttribution("The app crashes on launch.", {
      issueBody: true,
      required: true,
    });
    assert.equal(required.ok, true);
    assert.equal(required.skipped, true);
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

  it("accepts the skill's v2 run-receipt footer (#18457)", () => {
    const result = evaluateCommentAttribution(
      `CLAIMING: verified work\n\n${receiptFooter()}`,
    );
    assert.equal(
      result.ok,
      true,
      result.findings.map((finding) => finding.message).join("; "),
    );
    assert.equal(result.attribution.kind, "machine");
    assert.equal(result.attribution.model, "claude-opus-5");
  });

  it("rejects malformed v2 markers, extra fields, and duplicate markers", () => {
    const missingRun = evaluateCommentAttribution(
      receiptFooter({}, { run: undefined }),
      { required: true },
    );
    assert.equal(missingRun.ok, false);
    assert.ok(
      missingRun.findings.some((finding) => finding.id === "marker-fields"),
    );

    const scalarRun = evaluateCommentAttribution(
      receiptFooter({}, { run: "signed" }),
      { required: true },
    );
    assert.equal(scalarRun.ok, false);
    assert.ok(
      scalarRun.findings.some((finding) => finding.id === "marker-run"),
    );

    const extraField = evaluateCommentAttribution(
      receiptFooter({}, { session_id: "private" }),
      { required: true },
    );
    assert.equal(extraField.ok, false);
    assert.ok(
      extraField.findings.some((finding) => finding.id === "marker-fields"),
    );

    const mismatchedProvider = evaluateCommentAttribution(
      receiptFooter({ providerSlug: "openai" }),
      { required: true },
    );
    assert.equal(mismatchedProvider.ok, false);
    assert.ok(
      mismatchedProvider.findings.some(
        (finding) => finding.id === "marker-provider",
      ),
    );

    const bothMarkers = evaluateCommentAttribution(
      `${machineFooter()}\n${receiptFooter()}`,
      { required: true },
    );
    assert.equal(bothMarkers.ok, false);
    assert.ok(bothMarkers.findings.some((finding) => finding.id === "marker"));
  });

  it("ignores quoted and fenced v2 markers", () => {
    const quoted = evaluateCommentAttribution(
      '> <!-- elizaos-contribution-attribution:v2 {"provider":"fake"} -->',
    );
    assert.equal(quoted.skipped, true);
    const fenced = evaluateCommentAttribution(
      '```text\n<!-- elizaos-contribution-attribution:v2 {"provider":"fake"} -->\n```',
    );
    assert.equal(fenced.skipped, true);
  });

  it("accepts unattributed human prose and rejects conflicting declarations", () => {
    assert.equal(
      evaluateCommentAttribution("CLAIMING: work\n\nhuman-only").ok,
      true,
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

    for (const [provider, providerSlug] of [
      ["AI", "ai"],
      ["None", "none"],
      ["N_A", "n-a"],
    ]) {
      const genericProvider = evaluateCommentAttribution(
        machineFooter({ provider, providerSlug }),
        { required: true },
      );
      assert.equal(genericProvider.ok, false, provider);
      assert.ok(
        genericProvider.findings.some(
          (finding) => finding.id === "provider-model",
        ),
        provider,
      );
    }

    for (const model of ["N/A", "none", "openai/gpt"]) {
      const genericModel = evaluateCommentAttribution(
        machineFooter({ model }),
        {
          required: true,
        },
      );
      assert.equal(genericModel.ok, false, model);
      assert.ok(
        genericModel.findings.some(
          (finding) => finding.id === "provider-model",
        ),
        model,
      );
    }
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
});
