#!/usr/bin/env node
/**
 * Merges auto-heal pull requests once CI proves the fix, and reports the ones
 * CI rejects.
 *
 * This exists as a polling watcher rather than GitHub's own auto-merge because
 * `allow_auto_merge` is disabled on this repository, so nothing merges a green
 * pull request unless something asks for it. The merge condition is deliberately
 * the same aggregate gate a human PR must clear — `Develop PR Gate`, which
 * itself waits on lint, typecheck, build, gitleaks, and the PR metadata checks
 * (packages/scripts/develop-pr-aggregate.mjs). Auto-heal gets no shortcut and no
 * second, weaker definition of "green".
 *
 * `evaluateMergeReadiness()` is pure: this process merges to `develop` without a
 * human, so every reason to hold must be enumerable in a test.
 *
 * Consumed by .github/workflows/claude-autoheal-merge.yml.
 */

import { pathToFileURL } from "node:url";

import { AUTOHEAL_LABEL } from "./ci-autoheal-context.mjs";

/** The aggregate check that gates every merge into develop. */
export const REQUIRED_GATE_CHECK = "Develop PR Gate";

/** Merge strategy: develop's history is one squashed commit per pull request. */
export const MERGE_METHOD = "squash";

export const MERGE_READY = "merge";
export const MERGE_WAIT = "wait";
export const MERGE_BLOCKED = "blocked";

/**
 * Decides what to do with one heal pull request.
 *
 * `checkRuns` are the check runs for the head SHA; `reviews` the submitted
 * reviews. A human "request changes" always wins — auto-heal must never merge
 * over a person who looked at the diff and said no.
 */
export function evaluateMergeReadiness({ pr, checkRuns, reviews = [] }) {
  if (pr.draft)
    return { action: MERGE_WAIT, reason: "pull request is a draft" };
  if (pr.state !== "open")
    return { action: MERGE_BLOCKED, reason: `pull request is ${pr.state}` };

  const changesRequested = reviews.some(
    (review) => review.state === "CHANGES_REQUESTED",
  );
  if (changesRequested) {
    return { action: MERGE_BLOCKED, reason: "a reviewer requested changes" };
  }

  const gate = checkRuns.find((check) => check.name === REQUIRED_GATE_CHECK);
  if (!gate) {
    return {
      action: MERGE_WAIT,
      reason: `${REQUIRED_GATE_CHECK} has not reported yet`,
    };
  }
  if (gate.status !== "completed") {
    return {
      action: MERGE_WAIT,
      reason: `${REQUIRED_GATE_CHECK} is ${gate.status}`,
    };
  }
  if (gate.conclusion !== "success") {
    return {
      action: MERGE_BLOCKED,
      reason: `${REQUIRED_GATE_CHECK} concluded ${gate.conclusion}`,
      gateUrl: gate.html_url,
    };
  }

  // `mergeable_state` is computed asynchronously by GitHub; "unknown" means the
  // answer is not ready, which is a wait, not a refusal.
  if (pr.mergeable === null || pr.mergeable_state === "unknown") {
    return {
      action: MERGE_WAIT,
      reason: "GitHub has not finished computing mergeability",
    };
  }
  if (pr.mergeable === false) {
    return {
      action: MERGE_BLOCKED,
      reason: `pull request has conflicts (${pr.mergeable_state})`,
    };
  }
  if (pr.mergeable_state === "behind") {
    return {
      action: MERGE_WAIT,
      reason: "branch is behind its base and must be updated",
    };
  }

  return { action: MERGE_READY, reason: `${REQUIRED_GATE_CHECK} passed` };
}

function requireEnv(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function createClient(token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  return async function request(path, options = {}) {
    const response = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers: { ...headers, ...options.headers },
    });
    if (!response.ok) {
      throw new Error(
        `GitHub API ${response.status} for ${path}: ${await response.text()}`,
      );
    }
    return response.status === 204 ? null : response.json();
  };
}

export async function main(env = process.env) {
  const repo = requireEnv(env, "GITHUB_REPOSITORY");
  const token = requireEnv(env, "GITHUB_TOKEN");
  const dryRun = env.MERGE_DRY_RUN === "1";
  const request = createClient(token);

  const search = await request(
    `/search/issues?q=${encodeURIComponent(`repo:${repo} is:pr is:open label:${AUTOHEAL_LABEL}`)}&per_page=50`,
  );
  const candidates = search.items ?? [];
  console.log(
    `found ${candidates.length} open ${AUTOHEAL_LABEL} pull requests`,
  );

  const outcomes = [];
  for (const item of candidates) {
    const pr = await request(`/repos/${repo}/pulls/${item.number}`);
    const [checks, reviews] = await Promise.all([
      request(`/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`),
      request(`/repos/${repo}/pulls/${pr.number}/reviews?per_page=100`),
    ]);
    const verdict = evaluateMergeReadiness({
      pr,
      checkRuns: checks.check_runs ?? [],
      reviews,
    });
    console.log(`#${pr.number}: ${verdict.action} — ${verdict.reason}`);
    outcomes.push({ number: pr.number, ...verdict });

    if (verdict.action !== MERGE_READY || dryRun) continue;

    await request(`/repos/${repo}/pulls/${pr.number}/merge`, {
      method: "PUT",
      body: JSON.stringify({
        merge_method: MERGE_METHOD,
        commit_title: `${pr.title} (#${pr.number})`,
        commit_message: `Auto-healed CI failure. ${REQUIRED_GATE_CHECK} passed before merge.`,
      }),
    });
    console.log(`#${pr.number}: merged`);
  }
  return outcomes;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
