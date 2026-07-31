/**
 * Guards the wiring between the Claude autoheal/review workflows and the
 * scripts they execute: the credential that exists, the PAT that makes heal
 * PRs trigger CI, the branch guards, and the fork/draft safety gates. These
 * are the properties whose silent loss would leave the automation dead or
 * unsafe without any test going red.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  AUTOHEAL_LABEL,
  HEALABLE_BASE_BRANCH,
} from "../ci-autoheal-context.mjs";
import { REQUIRED_GATE_CHECK } from "../ci-autoheal-merge.mjs";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}/${path}`, "utf8");

const autoheal = read(".github/workflows/claude-ci-autoheal.yml");
const merge = read(".github/workflows/claude-autoheal-merge.yml");
const review = read(".github/workflows/claude-code-review.yml");
const mention = read(".github/workflows/claude.yml");

describe("credentials", () => {
  test("every Claude workflow authenticates with ANTHROPIC_API_KEY, the secret that exists", () => {
    for (const [name, body] of [
      ["claude-ci-autoheal", autoheal],
      ["claude-code-review", review],
      ["claude", mention],
    ] as const) {
      expect(body, `${name} must use ANTHROPIC_API_KEY`).toContain(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal Actions expression syntax
        "anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}",
      );
      expect(
        body,
        `${name} must not reference the never-configured OAuth token`,
      ).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    }
  });

  test("the heal branch is pushed with GH_PAT so the resulting PR triggers CI", () => {
    // Default-token pushes never fire pull_request workflows; the gate would
    // stay silent and the heal PR could never merge.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal Actions expression syntax
    expect(autoheal).toContain("token: ${{ secrets.GH_PAT }}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal Actions expression syntax
    expect(autoheal).toContain("github_token: ${{ secrets.GH_PAT }}");
  });
});

describe("autoheal workflow", () => {
  test("executes the tested context builder and honors its verdict", () => {
    expect(autoheal).toContain("node packages/scripts/ci-autoheal-context.mjs");
    expect(autoheal).toContain("steps.context.outputs.proceed == 'true'");
    expect(existsSync(`${ROOT}/packages/scripts/ci-autoheal-context.mjs`)).toBe(
      true,
    );
  });

  test("YAML pre-filter matches the script's branch policy", () => {
    expect(autoheal).toContain(`head_branch == '${HEALABLE_BASE_BRANCH}'`);
    expect(autoheal).toContain(
      "startsWith(github.event.workflow_run.head_branch, 'claude/autoheal/')",
    );
  });

  test("monitors the develop CI lanes by their exact display names", () => {
    for (const workflowName of [
      "Develop PR",
      "ci",
      "Develop Exhaustive Lane",
      "Quality (Extended)",
    ]) {
      expect(autoheal).toContain(`- ${workflowName}`);
    }
    // Display-name drift silently detaches workflow_run triggers.
    expect(read(".github/workflows/develop-pr.yml")).toContain(
      "name: Develop PR",
    );
    expect(read(".github/workflows/ci.yaml")).toContain("name: ci");
    expect(read(".github/workflows/develop-exhaustive.yml")).toContain(
      "name: Develop Exhaustive Lane",
    );
    expect(read(".github/workflows/quality.yml")).toContain(
      "name: Quality (Extended)",
    );
  });

  test("instructs the agent to label the PR so the merge watcher can find it", () => {
    expect(autoheal).toContain(AUTOHEAL_LABEL);
  });

  test("never masks its own failures with continue-on-error", () => {
    // The bare phrase appears in the agent prompt's forbidden list; the YAML
    // key form is what would mask a real failure.
    expect(autoheal).not.toContain("continue-on-error:");
  });
});

describe("merge watcher", () => {
  test("runs the tested merge evaluator on a schedule", () => {
    expect(merge).toContain("node packages/scripts/ci-autoheal-merge.mjs");
    expect(merge).toMatch(/cron: "\*\/15 \* \* \* \*"/);
    expect(existsSync(`${ROOT}/packages/scripts/ci-autoheal-merge.mjs`)).toBe(
      true,
    );
  });

  test("merge gate is the develop aggregate, defined once in the script", () => {
    expect(REQUIRED_GATE_CHECK).toBe("Develop PR Gate");
    // The watcher yml must not pass its own gate definition into the script —
    // prose mentions are fine, a second machine-read copy is not.
    expect(merge).not.toMatch(/GATE[_A-Z]*:|check_name/i);
  });
});

describe("deep review workflow", () => {
  test("keeps the rule-referenced claude-review job name", () => {
    expect(review).toContain("claude-review:");
    expect(review).toContain("name: claude-review");
  });

  test("builds the dossier from the BASE ref before the agent runs", () => {
    expect(review).toContain(
      "node packages/scripts/pr-deep-review-context.mjs",
    );
    expect(review.indexOf("pull_request.base.sha")).toBeLessThan(
      review.indexOf("run: node packages/scripts/pr-deep-review-context.mjs"),
    );
    expect(
      existsSync(`${ROOT}/packages/scripts/pr-deep-review-context.mjs`),
    ).toBe(true);
  });

  test("fork pull requests never reach the agent step", () => {
    expect(review).toContain("head.repo.full_name != github.repository");
    expect(review).toContain("run_review=false");
    expect(review).toContain("steps.classify.outputs.run_review == 'true'");
  });

  test("review agent is read-only: no Edit/Write tools, no PAT", () => {
    expect(review).not.toContain('"Bash,');
    expect(review).not.toMatch(/allowedTools[^\n]*(Edit|Write)/);
    expect(review).not.toContain("GH_PAT");
  });

  test("stays advisory: model failure cannot redden the check", () => {
    expect(review).toContain("continue-on-error: true");
  });
});
