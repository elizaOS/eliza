/**
 * Exercises the model-attribution gate against the human-only and
 * machine-assisted declarations contributors put in pull request bodies.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  evaluatePrAttribution,
  extractAttributionRows,
  extractModelIds,
} from "./check-pr-agent-attribution.mjs";
import {
  evaluatePrEvidence,
  REQUIRED_EVIDENCE_ROWS,
} from "./check-pr-evidence.mjs";

const workingRoot = path.resolve(process.cwd());
const repositoryRoot = existsSync(
  path.join(workingRoot, ".github", "workflows"),
)
  ? workingRoot
  : path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const workflowsDirectory = path.join(repositoryRoot, ".github", "workflows");
const validatorPath = fileURLToPath(
  new URL("./check-pr-agent-attribution.mjs", import.meta.url),
);

function body({
  assistance = "yes",
  models = "`openai/gpt-5.6-sol`",
  client = "Codex Desktop",
  revision = "`elizaOS/eliza@0123456789abcdef0123456789abcdef01234567:packages/skills/skills/contribute-to-eliza`",
  status = "self-reported",
} = {}) {
  // Labels match .github/pull_request_template.md (#17855): they must not reuse
  // the terminal army footer labels or the scorer drops the machine marker.
  return `<!-- contribution-attribution:v1 -->
<!-- attribution-row:ai-assistance -->
- AI assistance: ${assistance}
<!-- attribution-row:models -->
- Model(s) used: ${models}
<!-- attribution-row:client -->
- Agent tooling: ${client}
<!-- attribution-row:skill-revision -->
- Skill path: ${revision}
<!-- attribution-row:status -->
- Provenance status: ${status}`;
}

function workflowSource(workflowPath) {
  return readFileSync(path.join(repositoryRoot, workflowPath), "utf8");
}

function runAttributionCli(markdown) {
  const fixtureDirectory = mkdtempSync(
    path.join(tmpdir(), "eliza-pr-attribution-"),
  );
  const bodyPath = path.join(fixtureDirectory, "body.md");
  writeFileSync(bodyPath, markdown);
  return spawnSync(process.execPath, [validatorPath, "--body-file", bodyPath], {
    encoding: "utf8",
  });
}

function generatedPrWorkflowPaths() {
  return readdirSync(workflowsDirectory)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => `.github/workflows/${name}`)
    .filter((workflowPath) => {
      const source = workflowSource(workflowPath);
      return (
        /^\s*gh\s+pr\s+create\b/m.test(source) ||
        /peter-evans\/create-pull-request@/.test(source)
      );
    })
    .sort();
}

function dedent(block) {
  const lines = block.replace(/\r\n/g, "\n").split("\n");
  const indentation = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^\s*/)?.[0].length ?? 0);
  const width = Math.min(...indentation);
  return lines
    .map((line) => line.slice(width))
    .join("\n")
    .trim();
}

function heredocBodies(source) {
  return [
    ...source.matchAll(/<<'([A-Z][A-Z0-9_]*)'\r?\n([\s\S]*?)\r?\n\s*\1\b/g),
  ].map((match) => dedent(match[2]));
}

function yamlLiteralBodies(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const bodies = [];
  for (let index = 0; index < lines.length; index += 1) {
    const marker = lines[index].match(/^(\s*)body:\s*\|\s*$/);
    if (!marker) continue;
    const indentation = marker[1].length;
    const bodyLines = [];
    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      const line = lines[bodyIndex];
      if (
        line.trim().length > 0 &&
        (line.match(/^\s*/)?.[0].length ?? 0) <= indentation
      ) {
        break;
      }
      bodyLines.push(line);
    }
    bodies.push(dedent(bodyLines.join("\n")));
  }
  return bodies;
}

async function generatedPrBody(workflowPath) {
  const source = workflowSource(workflowPath);
  const heredocs = heredocBodies(source);
  const completeHeredoc = heredocs.find(
    (candidate) =>
      candidate.includes("<!-- contribution-attribution:v1 -->") &&
      candidate.includes("<!-- evidence-row:before-screenshots -->"),
  );
  if (completeHeredoc) return completeHeredoc;

  const yamlBody = yamlLiteralBodies(source).find(
    (candidate) =>
      candidate.includes("<!-- contribution-attribution:v1 -->") &&
      candidate.includes("<!-- evidence-row:before-screenshots -->"),
  );
  if (yamlBody) return yamlBody;

  assert.fail(`${workflowPath} has no extractable generated PR body`);
}

describe("PR agent attribution", () => {
  it("accepts an unattributed PR body in both library and CLI paths", () => {
    const markdown = "Implements the linked issue with tests and evidence.";
    const result = evaluatePrAttribution(markdown);
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.attribution, null);

    const cli = runAttributionCli(markdown);
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /No pull-request attribution block/);
  });

  it("validates a voluntary footer without requiring template rows", () => {
    const footer = `AI provider/model: OpenAI / gpt-5.6-sol
Client / agent tooling: Codex Desktop
Contribution skill revision: elizaOS/eliza@0123456789abcdef0123456789abcdef01234567:packages/skills/skills/contribute-to-eliza
Attribution status: self-reported
— [optional-proof]
<!-- eliza-computer-attribution:v1 {"provider":"openai","model":"gpt-5.6-sol","client":"Codex Desktop","skill_revision":"elizaOS/eliza@0123456789abcdef0123456789abcdef01234567:packages/skills/skills/contribute-to-eliza"} -->`;
    const accepted = evaluatePrAttribution(footer);
    assert.equal(accepted.ok, true);
    assert.equal(accepted.skipped, false);
    assert.deepEqual(accepted.attribution.modelIds, ["openai/gpt-5.6-sol"]);

    const malformed = evaluatePrAttribution(
      footer.replace('"model":"gpt-5.6-sol"', '"model":"wrong"'),
    );
    assert.equal(malformed.ok, false);
    assert.ok(
      malformed.findings.some((finding) => finding.id === "marker-model"),
    );
  });

  it("accepts one or more exact provider/model identifiers", () => {
    const result = evaluatePrAttribution(
      body({
        models: "`openai/gpt-5.6-sol`, `anthropic/claude-sonnet-4-6`",
      }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.attribution.modelIds, [
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5.6-sol",
    ]);
  });

  it("accepts an explicit human-only declaration", () => {
    const result = evaluatePrAttribution(
      body({
        assistance: "no - human-only contribution",
        models: "None - human-only contribution",
        client: "None - human-only contribution",
        revision: "N/A - no contribution skill used",
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.attribution.aiAssistance, "no");
    assert.equal(result.attribution.kind, "human-only");
    assert.deepEqual(result.attribution.modelIds, []);
  });

  it("requires one specific no-AI reason and distinguishes deterministic work", () => {
    const deterministicBody = body({
      assistance: "no - Deterministic   workflow",
      models: "None - deterministic workflow",
      client: "None - deterministic workflow",
      revision: "N/A - deterministic workflow does not invoke a skill",
    });
    const deterministic = evaluatePrAttribution(deterministicBody);
    assert.equal(deterministic.ok, true);
    assert.equal(deterministic.attribution.kind, "deterministic");
    assert.equal(
      deterministic.attribution.noAiReason,
      "deterministic workflow",
    );

    const mixed = evaluatePrAttribution(
      deterministicBody.replace(
        "Agent tooling: None - deterministic workflow",
        "Agent tooling: None - human-only contribution",
      ),
    );
    assert.equal(mixed.ok, false);
    assert.ok(mixed.findings.some((finding) => finding.id === "no-ai-reason"));

    const vague = evaluatePrAttribution(
      deterministicBody
        .replace("no - Deterministic   workflow", "no - deterministic")
        .replaceAll("None - deterministic workflow", "None - deterministic"),
    );
    assert.equal(vague.ok, false);
    assert.ok(vague.findings.some((finding) => finding.id === "no-ai-reason"));

    const wrongAssistancePrefix = evaluatePrAttribution(
      deterministicBody.replace(
        "AI assistance: no - Deterministic   workflow",
        "AI assistance: None - deterministic workflow",
      ),
    );
    assert.equal(wrongAssistancePrefix.ok, false);
    assert.ok(
      wrongAssistancePrefix.findings.some(
        (finding) => finding.id === "ai-assistance",
      ),
    );
  });

  it("reports human-only and deterministic declarations distinctly in CLI output", () => {
    const human = runAttributionCli(
      body({
        assistance: "no - human-only contribution",
        models: "None - human-only contribution",
        client: "None - human-only contribution",
        revision: "N/A - no contribution skill used",
      }),
    );
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /Contribution attribution valid: human-only\./);

    const deterministic = runAttributionCli(
      body({
        assistance: "no - deterministic workflow",
        models: "None - deterministic workflow",
        client: "None - deterministic workflow",
        revision: "N/A - deterministic workflow does not invoke a skill",
      }),
    );
    assert.equal(deterministic.status, 0, deterministic.stderr);
    assert.match(
      deterministic.stdout,
      /Contribution attribution valid: deterministic\./,
    );
  });

  it("rejects vague model names and template placeholders", () => {
    const vague = evaluatePrAttribution(body({ models: "GPT" }));
    assert.equal(vague.ok, false);
    assert.ok(vague.findings.some((finding) => finding.id === "models"));

    const placeholder = evaluatePrAttribution(
      body({ models: "`provider/model`" }),
    );
    assert.equal(placeholder.ok, false);
    assert.ok(placeholder.findings.some((finding) => finding.id === "models"));

    const generic = evaluatePrAttribution(body({ models: "`openai/model`" }));
    assert.equal(generic.ok, false);
    assert.ok(generic.findings.some((finding) => finding.id === "models"));

    for (const models of [
      "`AI/gpt-5.4`",
      "`none/gpt-5.4`",
      "`na/gpt-5.4`",
      "`n_a/gpt-5.4`",
      "`n/a`",
      "`openai/N-A`",
      "`openrouter/anthropic/gpt`",
    ]) {
      const genericProvider = evaluatePrAttribution(body({ models }));
      assert.equal(genericProvider.ok, false, models);
      assert.ok(
        genericProvider.findings.some((finding) => finding.id === "models"),
        models,
      );
    }
  });

  it("does not treat incidental no/none prose as a human-only declaration", () => {
    const result = evaluatePrAttribution(
      body({
        assistance: "yes - no private prompts were included",
        models: "None - human-only contribution",
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.attribution.aiAssistance, "yes");
    assert.ok(result.findings.some((finding) => finding.id === "models"));
  });

  it("rejects concrete AI tooling on a human-only contribution", () => {
    const result = evaluatePrAttribution(
      body({
        assistance: "no - human-only contribution",
        models: "None - human-only contribution",
        client: "codex-desktop",
        revision: "N/A - no contribution skill used",
      }),
    );
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.id === "client"));
  });

  it("requires concrete client and skill-revision provenance", () => {
    const missingClient = evaluatePrAttribution(
      body({ client: "N/A - client was not recorded" }),
    );
    assert.equal(missingClient.ok, false);
    assert.ok(
      missingClient.findings.some((finding) => finding.id === "client"),
    );

    const shortRevision = evaluatePrAttribution(
      body({ revision: "`elizaOS/eliza@abc123:packages/skills`" }),
    );
    assert.equal(shortRevision.ok, false);
    assert.ok(
      shortRevision.findings.some((finding) => finding.id === "skill-revision"),
    );

    const noSkill = evaluatePrAttribution(
      body({ revision: "N/A - no contribution skill used" }),
    );
    assert.equal(noSkill.ok, true);
  });

  it("keeps a value's own colon when the row omits the optional label", () => {
    // The label ("Skill revision: ") is optional, and a contributor who writes
    // the format the failure message prescribes omits it. Stripping to the
    // first colon then consumed the value itself, so the documented
    // `owner/repo@<40-hex>:path` was rejected by the message prescribing it.
    const unlabelled = [
      "<!-- contribution-attribution:v1 -->",
      "<!-- attribution-row:ai-assistance --> yes",
      "<!-- attribution-row:models --> `openai/gpt-5.6-sol`",
      "<!-- attribution-row:client --> Codex Desktop",
      "<!-- attribution-row:skill-revision --> `elizaOS/eliza@0123456789abcdef0123456789abcdef01234567:packages/skills/skills/contribute-to-eliza`",
      "<!-- attribution-row:status --> self-reported",
    ].join("\n");
    const result = evaluatePrAttribution(unlabelled);
    assert.equal(
      result.ok,
      true,
      result.findings.map((finding) => finding.message).join("; "),
    );
    assert.equal(
      result.attribution.skillRevision,
      "elizaOS/eliza@0123456789abcdef0123456789abcdef01234567:packages/skills/skills/contribute-to-eliza",
    );

    // The same hazard one row over: a routed identifier may carry a colon, and
    // an unlabelled one was truncated to the trailing segment and then read as
    // a placeholder rather than as a model.
    assert.deepEqual(
      evaluatePrAttribution(
        unlabelled.replace(
          "`openai/gpt-5.6-sol`",
          "`bedrock/anthropic.claude-3:1`",
        ),
      ).attribution.modelIds,
      ["bedrock/anthropic.claude-3:1"],
    );
  });

  it("still drops a human label, including one containing a slash", () => {
    // The strip exists for the documented template, so refusing to run past a
    // value's colon must not stop it removing a genuine label. Legacy
    // `Client / agent tooling:` still works when present and carries a slash.
    const labelled = evaluatePrAttribution(
      body().replace("Agent tooling:", "Client / agent tooling:"),
    );
    assert.equal(labelled.ok, true);
    assert.equal(labelled.attribution.client, "Codex Desktop");
    assert.equal(
      labelled.attribution.status,
      "self-reported",
      "a labelled status row must still reduce to the bare keyword",
    );
    assert.deepEqual(labelled.attribution.modelIds, ["openai/gpt-5.6-sol"]);
  });

  it("accepts the skill's v2 receipt marker alongside or instead of the bare template marker (#18457)", () => {
    const receiptFooter = `AI provider/model: anthropic / claude-opus-5
Client / agent tooling: Claude Code
Contribution skill revision: elizaOS/army@9259107132edeab02d9e47dbb7ce383721bada77:skills/contribute-to-eliza
Compute receipt: 1234 project-attributed tokens (exact; device-signed, locally reported)
Attribution status: self-reported
— [qa-agent]
<!-- elizaos-contribution-attribution:v2 {"provider":"anthropic","model":"claude-opus-5","client":"Claude Code","skill_revision":"elizaOS/army@9259107132edeab02d9e47dbb7ce383721bada77:skills/contribute-to-eliza","run":{"schema_version":"1","run_id":"0f2c","device_signature":"abc123"}} -->`;

    // A filled template plus the appended skill footer carries one marker of
    // each spelling and must pass.
    const both = evaluatePrAttribution(`${body()}\n\n${receiptFooter}`);
    assert.equal(
      both.ok,
      true,
      both.findings.map((finding) => finding.message).join("; "),
    );

    // The v2 receipt alone satisfies the marker requirement when the rows
    // are present without the bare template marker.
    const withoutTemplateMarker = body().replace(
      "<!-- contribution-attribution:v1 -->\n",
      "",
    );
    const v2Only = evaluatePrAttribution(
      `${withoutTemplateMarker}\n\n${receiptFooter}`,
    );
    assert.equal(
      v2Only.ok,
      true,
      v2Only.findings.map((finding) => finding.message).join("; "),
    );

    // Duplicate v2 receipts are still rejected.
    const duplicated = evaluatePrAttribution(
      `${body()}\n\n${receiptFooter}\n${receiptFooter}`,
    );
    assert.equal(duplicated.ok, false);
    assert.ok(
      duplicated.findings.some(
        (finding) => finding.id === "marker" && finding.status === "duplicate",
      ),
    );

    // Neither marker present still reports missing.
    const missing = evaluatePrAttribution(withoutTemplateMarker);
    assert.equal(missing.ok, false);
    assert.ok(
      missing.findings.some(
        (finding) => finding.id === "marker" && finding.status === "missing",
      ),
    );
  });

  it("keeps the PR template free of mandatory attribution inputs", () => {
    const templatePath = path.join(
      repositoryRoot,
      ".github",
      "pull_request_template.md",
    );
    const template = readFileSync(templatePath, "utf8");
    assert.doesNotMatch(template, /contribution-attribution:v1/);
    assert.doesNotMatch(template, /attribution-row:/);
    assert.doesNotMatch(template, /Model\(s\) used:/);
    const result = evaluatePrAttribution(template);
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.attribution, null);
  });

  it("accepts prose that names a model without declaring attribution", () => {
    const result = evaluatePrAttribution(
      "Built with openai/gpt-5.6-sol using Codex Desktop.",
    );
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.attribution, null);
  });

  it("rejects duplicate blocks and row markers instead of choosing one", () => {
    const duplicateBlock = evaluatePrAttribution(`${body()}\n\n${body()}`);
    assert.equal(duplicateBlock.ok, false);
    assert.ok(
      duplicateBlock.findings.some(
        (finding) => finding.id === "marker" && finding.status === "duplicate",
      ),
    );

    const duplicateRow = evaluatePrAttribution(
      body().replace(
        "<!-- attribution-row:models -->",
        "<!-- attribution-row:models -->\n- Model(s) used: `openai/gpt-5.6-sol`\n<!-- attribution-row:models -->",
      ),
    );
    assert.equal(duplicateRow.ok, false);
    assert.ok(
      duplicateRow.findings.some(
        (finding) => finding.id === "models" && finding.status === "duplicate",
      ),
    );
  });

  it("requires self-reported status because declarations are not attestations", () => {
    const result = evaluatePrAttribution(body({ status: "verified" }));
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.id === "status"));
  });

  it("parses row blocks without consuming the next marker", () => {
    const rows = extractAttributionRows(body());
    assert.match(rows.get("models"), /openai\/gpt-5\.6-sol/);
    assert.doesNotMatch(rows.get("models"), /Client/);
  });

  it("deduplicates normalized model identifiers", () => {
    assert.deepEqual(
      extractModelIds(
        "`OpenAI/GPT-5.6-SOL`, openai/gpt-5.6-sol; anthropic/claude-sonnet-4-6",
      ),
      ["anthropic/claude-sonnet-4-6", "openai/gpt-5.6-sol"],
    );
  });

  it("accepts nested routed model identifiers without accepting placeholders", () => {
    assert.deepEqual(
      extractModelIds(
        "`openrouter/anthropic/claude-sonnet-4`, `openrouter/openai/model`",
      ),
      ["openrouter/anthropic/claude-sonnet-4"],
    );
    assert.equal(
      evaluatePrAttribution(
        body({ models: "`openrouter/anthropic/claude-sonnet-4`" }),
      ).ok,
      true,
    );
  });

  it("discovers and validates every workflow-generated PR body", async () => {
    const workflowPaths = generatedPrWorkflowPaths();
    for (const workflowPath of workflowPaths) {
      const source = workflowSource(workflowPath);
      assert.match(
        source,
        /(?:--base|base:)\s+develop\b/,
        `${workflowPath} must target develop`,
      );
      const generatedBody = await generatedPrBody(workflowPath);
      const attribution = evaluatePrAttribution(generatedBody);
      assert.equal(
        attribution.ok,
        true,
        `${workflowPath} attribution: ${attribution.findings
          .map((finding) => finding.message)
          .join("; ")}`,
      );
      const evidence = evaluatePrEvidence(
        generatedBody,
        REQUIRED_EVIDENCE_ROWS,
      );
      assert.equal(
        evidence.ok,
        true,
        `${workflowPath} evidence: ${evidence.findings
          .map((finding) => `${finding.id}=${finding.status}`)
          .join("; ")}`,
      );
    }
  });
});
