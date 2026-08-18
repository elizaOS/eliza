/**
 * Auto-submit intent gate for provisioned-repo tasks: the orchestrator opens
 * a PR on completion only when the user actually asked for one. The rest of
 * the OrchestratorTaskService suite (park notices, request-voice carry,
 * teardown) rides the spawn/lifecycle and voice replacement PRs.
 */
import { describe, expect, it } from "vitest";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.ts";

describe("wantsPullRequest (auto-submit intent gate)", () => {
  it("matches natural PR asks", () => {
    for (const text of [
      "add hello.md and open a pull request",
      "commit, push, open a PR. only that repo",
      "hey can u add a hello.md to my repo and pr it",
      "make a merge request for this",
    ]) {
      expect(OrchestratorTaskService.wantsPullRequest(text)).toBe(true);
    }
  });

  it("stays quiet for repo work without PR intent", () => {
    for (const text of [
      "fix the failing test in my sandbox repo",
      "clone the repo and summarize the readme",
      "improve the prompt wording",
      // Negated PR mentions are declines, not asks (live 2026-08-18: the
      // bare \bpr\b token in "no pr needed" opened the declined PR).
      "fix the typo in the readme, just commit it locally no pr needed",
      "commit the change but don't open a pr",
      "update the docs, skip the pull request",
      "push nothing and never open a pr for this",
    ]) {
      expect(OrchestratorTaskService.wantsPullRequest(text)).toBe(false);
    }
  });
});
