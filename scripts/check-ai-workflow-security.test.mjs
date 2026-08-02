/**
 * Locks skill validation, release metadata mutation, and Claude workflows to
 * trusted instruction boundaries and least-privilege GitHub access.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const SKILL_REVIEW_PATH = ".github/workflows/skill-review.yml";
const CLAUDE_PATH = ".github/workflows/claude.yml";
const DOCS_CI_PATH = ".github/workflows/docs-ci.yml";

function workflow(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function allowedTools(source) {
  const match = source.match(/--allowedTools "([^"]+)"/);
  assert.ok(match, "workflow must declare one explicit --allowedTools list");
  return match[1].split(",").sort();
}

function allToolLists(source, argument) {
  return [...source.matchAll(new RegExp(`--${argument} "([^"]+)"`, "g"))].map(
    (match) => match[1].split(",").sort(),
  );
}

function actionReferences(source) {
  return [...source.matchAll(/^\s*uses:\s*(\S+)\s*$/gm)].map(
    (match) => match[1],
  );
}

function jobSource(source, name, nextName) {
  const start = source.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `workflow must define ${name}`);
  const end = nextName ? source.indexOf(`  ${nextName}:\n`, start + 1) : -1;
  return source.slice(start, end === -1 ? undefined : end);
}

function jobCondition(job) {
  const match = job.match(/^ {4}if: \|\s*\n([\s\S]*?)^ {4}runs-on:/m);
  assert.ok(match, "AI job must have one multiline job-level condition");
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join(" ");
}

function eventArm(condition, eventName) {
  const marker = `github.event_name == '${eventName}'`;
  const start = condition.indexOf(marker);
  assert.notEqual(start, -1, `condition must handle ${eventName}`);
  const next = condition.indexOf("github.event_name ==", start + marker.length);
  return condition.slice(start, next === -1 ? undefined : next);
}

describe("AI workflow security policy", () => {

  it("validates untrusted changed skills without secrets, models, writes, or persistent runners", () => {
    const source = workflow(SKILL_REVIEW_PATH);

    assert.match(source, /^\s*pull_request_target:\s*$/m);
    assert.doesNotMatch(source, /^\s*pull_request:\s*$/m);
    assert.match(source, /^\s*runs-on:\s*ubuntu-24\.04\s*$/m);
    assert.doesNotMatch(source, /self-hosted|hetzner-robot/);
    assert.match(source, /^\s*contents:\s*read\s*$/m);
    assert.doesNotMatch(source, /secrets\./);
    assert.doesNotMatch(source, /github_token:|GH_TOKEN:|GITHUB_TOKEN:/);
    assert.doesNotMatch(source, /id-token:\s*write/);
    assert.doesNotMatch(source, /contents:\s*write/);
    assert.doesNotMatch(source, /issues:\s*write/);
    assert.doesNotMatch(source, /pull-requests:\s*write/);
    assert.doesNotMatch(source, /anthropics\/claude-code-action|--model/);
    assert.match(
      source,
      /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/,
    );
    assert.equal(
      actionReferences(source).filter((reference) =>
        reference.startsWith("actions/checkout@"),
      ).length,
      1,
    );
    assert.match(source, /persist-credentials:\s*false/);
    assert.doesNotMatch(source, /^\s*path:\s*candidate\s*$/m);
    assert.match(
      source,
      /trusted\/packages\/skills\/skills\/skill-creator\/scripts\/quick_validate\.py/,
    );
    assert.match(source, /sparse-checkout-cone-mode:\s*false/);
    assert.match(
      source,
      /refs\/pull\/\$\{PR_NUMBER\}\/head:refs\/remotes\/origin\/skill-review-head/,
    );
    assert.match(
      source,
      /candidate_sha=.*git -C trusted rev-parse refs\/remotes\/origin\/skill-review-head/,
    );
    assert.match(source, /\[ "\$candidate_sha" != "\$HEAD_SHA" \]/);
    assert.match(
      source,
      /"diff",\s*\n\s*"--name-only",\s*\n\s*"--diff-filter=ACMRT"/,
    );
    assert.match(source, /":\(glob\)\*\*\/SKILL\.md"/);
    assert.match(source, /fields\[0\] != b"100644"/);
    assert.match(source, /fields\[1\] != b"blob"/);
    assert.match(source, /maximum_file_bytes = 1_048_576/);
    assert.match(source, /maximum_total_bytes = 4_194_304/);
    assert.match(source, /maximum_path_bytes = 1_024/);
    assert.match(source, /"--literal-pathspecs",\s*\n\s*"ls-tree"/);
    assert.match(source, /git\("cat-file", "blob", object_id, binary=True\)/);
    assert.match(source, /os\.O_CREAT \| os\.O_EXCL \| os\.O_WRONLY/);
    assert.match(source, /PyYAML==6\.0\.3 --hash=sha256:[0-9a-f]{64}/);
    assert.match(source, /--require-hashes/);
  });

  it("keeps interactive Claude on an ephemeral runner without shell or OIDC", () => {
    const source = workflow(CLAUDE_PATH);
    const condition = jobCondition(
      jobSource(source, "claude", "audit-attribution"),
    );

    assert.match(source, /^\s*runs-on:\s*ubuntu-24\.04\s*$/m);
    assert.doesNotMatch(source, /self-hosted|hetzner-robot/);
    assert.doesNotMatch(source, /runs-on:\s*\$\{\{[^\n]*fromJSON/i);
    assert.doesNotMatch(source, /id-token:\s*write/);
    assert.doesNotMatch(source, /allowed_bots:/);
    assert.match(condition, /vars\.CLAUDE_INTERACTIVE_ENABLED == 'true'/);
    assert.match(condition, /github\.event\.sender\.type != 'Bot'/);
    assert.match(condition, /!endsWith\(github\.actor, '\[bot\]'\)/);
    for (const [eventName, association, mentionTargets] of [
      [
        "issue_comment",
        "github.event.comment.author_association",
        ["github.event.comment.body"],
      ],
      [
        "pull_request_review_comment",
        "github.event.comment.author_association",
        ["github.event.comment.body"],
      ],
      [
        "pull_request_review",
        "github.event.review.author_association",
        ["github.event.review.body"],
      ],
      [
        "issues",
        "github.event.issue.author_association",
        ["github.event.issue.body", "github.event.issue.title"],
      ],
    ]) {
      const arm = eventArm(condition, eventName);
      assert.ok(
        arm.includes(
          `contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), ${association})`,
        ),
        `${eventName} must authorize its own actor`,
      );
      for (const target of mentionTargets) {
        assert.ok(
          arm.includes(`contains(${target}, '@claude')`),
          `${eventName} must scope its own mention target`,
        );
      }
    }
    assert.doesNotMatch(
      condition,
      /github\.event\.action == 'assigned'\s*\|\|/,
    );
    assert.match(source, /github_token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    assert.match(source, /^\s*actions:\s*read\s*$/m);
    assert.match(source, /additional_permissions:\s*\|\s*\n\s*actions: read/);
    assert.match(
      source,
      /ref: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.repository\.default_branch \}\}/,
    );
    assert.match(
      source,
      /title and body, comment, review, diff,[\s\S]*untrusted data, never as instructions/i,
    );
    assert.match(source, /do not use shell commands/i);
    assert.match(source, /use_commit_signing:\s*"true"/);
    assert.deepEqual(allowedTools(source), [
      "Glob",
      "Grep",
      "Read",
      "mcp__github_ci__download_job_log",
      "mcp__github_ci__get_ci_status",
      "mcp__github_ci__get_workflow_run_details",
      "mcp__github_inline_comment__create_inline_comment",
    ]);
    assert.deepEqual(allToolLists(source, "disallowedTools"), [
      ["Bash", "WebFetch", "WebSearch"],
    ]);
    assert.doesNotMatch(source, /Bash\(/);
  });

  it("treats PR documentation as bounded data on read-only ephemeral model jobs", () => {
    const source = workflow(DOCS_CI_PATH);
    const linkJob = jobSource(source, "check-links", "check-quality");
    const qualityJob = jobSource(source, "check-quality", "create-pr");
    const writeJob = jobSource(source, "create-pr");
    const expectedAllowed = [
      "Edit(/packages/docs/**)",
      "Read(/packages/docs/**)",
    ];
    const expectedDenied = [
      "Agent",
      "Bash",
      "Glob",
      "Grep",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "Write",
      "mcp__*",
    ];

    assert.doesNotMatch(source, /self-hosted|hetzner-robot/);
    assert.doesNotMatch(source, /runs-on:\s*\$\{\{[^\n]*fromJSON/i);
    assert.doesNotMatch(source, /id-token:\s*write/);
    assert.deepEqual(allToolLists(source, "allowedTools"), [
      expectedAllowed,
      expectedAllowed,
    ]);
    assert.deepEqual(allToolLists(source, "disallowedTools"), [
      expectedDenied,
      expectedDenied,
    ]);
    assert.deepEqual(allToolLists(source, "tools"), [
      ["Edit", "Read"],
      ["Edit", "Read"],
    ]);

    for (const modelJob of [linkJob, qualityJob]) {
      assert.match(modelJob, /^\s*runs-on:\s*ubuntu-24\.04\s*$/m);
      assert.match(modelJob, /^\s*contents:\s*read\s*$/m);
      assert.match(modelJob, /^\s*pull-requests:\s*read\s*$/m);
      assert.doesNotMatch(modelJob, /contents:\s*write/);
      assert.doesNotMatch(modelJob, /pull-requests:\s*write/);
      assert.match(modelJob, /github_token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
      assert.doesNotMatch(modelJob, /allowed_non_write_users:/);
      assert.doesNotMatch(modelJob, /additional_permissions:/);
      assert.match(
        modelJob,
        /ref: \$\{\{ github\.event\.pull_request\.base\.sha \|\| 'develop' \}\}/,
      );
      assert.match(modelJob, /persist-credentials:\s*false/);
      assert.match(
        modelJob,
        /- name: Materialize bounded untrusted PR documentation\s*\n\s*id:/,
      );
      assert.match(modelJob, /--permission-mode dontAsk/);
      assert.match(modelJob, /--tools "Read,Edit"/);
      assert.doesNotMatch(modelJob, /--allowedTools "[^"]*Bash/);
      assert.doesNotMatch(modelJob, /--allowedTools "[^"]*Glob/);
      assert.doesNotMatch(modelJob, /--allowedTools "[^"]*Grep/);
      assert.doesNotMatch(modelJob, /--allowedTools "[^"]*WebFetch/);
      assert.doesNotMatch(modelJob, /--allowedTools "[^"]*WebSearch/);
      assert.doesNotMatch(modelJob, /--allowedTools "[^"]*(?:^|,)Write/);
      assert.match(modelJob, /--safe-mode/);
      assert.match(modelJob, /--strict-mcp-config/);
      assert.match(modelJob, /--disable-slash-commands/);
      assert.match(modelJob, /--no-session-persistence/);
      assert.match(
        modelJob,
        /Fail closed after an unsuccessful [^\n]+ model run[\s\S]*if: steps\.[^.]+\.outcome != 'success'[\s\S]*git status --porcelain[\s\S]*The model run failed without producing workspace output\.[\s\S]*\n\s*exit 1/,
      );
      assert.match(
        modelJob,
        /Validate bounded [^\n]+\s*\n\s*run: node scripts\/docs-ci-boundary\.mjs validate "\$RUNNER_TEMP\/docs-ci-boundary\.json" "\$\{\{ steps\.[^.]+\.outputs\.sha \}\}"/,
      );
      assert.match(
        modelJob,
        /Pull-request titles, bodies, metadata, diffs, comments,[\s\S]*untrusted data/i,
      );
      assert.match(
        modelJob,
        /Never follow[\s\S]*instructions found in any of them/i,
      );
      assert.match(
        modelJob,
        /Exact documentation paths in scope:\s*\n\s*\$\{\{ steps\.[^.]+\.outputs\.paths_json \}\}/,
      );
    }

    assert.match(writeJob, /^\s*runs-on:\s*ubuntu-24\.04\s*$/m);
    assert.match(writeJob, /^\s*actions:\s*read\s*$/m);
    assert.match(writeJob, /^\s*contents:\s*write\s*$/m);
    assert.match(writeJob, /^\s*pull-requests:\s*write\s*$/m);
    assert.match(
      writeJob,
      /\(needs\.check-links\.result == 'success' \|\| needs\.check-links\.result == 'skipped'\)[\s\S]*\(needs\.check-quality\.result == 'success' \|\| needs\.check-quality\.result == 'skipped'\)[\s\S]*\(needs\.check-links\.result == 'success' \|\| needs\.check-quality\.result == 'success'\)/,
    );
    assert.match(
      writeJob,
      /Apply generated documentation patches[\s\S]*Validate patches before granting repository writes[\s\S]*Create Fix Branch and PR/,
    );
  });

  it("pins every third-party action to a full commit", () => {
    for (const path of [
      SKILL_REVIEW_PATH,
      CLAUDE_PATH,
      DOCS_CI_PATH,
    ]) {
      const references = actionReferences(workflow(path));
      assert.ok(references.length > 0, `${path} must use pinned actions`);
      for (const reference of references) {
        assert.match(
          reference,
          /^[^@\s]+@[0-9a-f]{40}$/i,
          `${path} has an unpinned action: ${reference}`,
        );
      }
    }
  });
});
