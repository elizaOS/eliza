/**
 * goalSimilarity feeds the near-duplicate spawn guard. Non-Latin goals must
 * tokenize on their own words, not collapse to the few ASCII tokens they share.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  findNearDuplicateInFlightWork,
  goalSimilarity,
} from "../actions/tasks.ts";
import type { OrchestratorTaskService } from "../services/orchestrator-task-service.ts";

const THRESHOLD = 0.6;

describe("goalSimilarity", () => {
  it("keeps distinct Korean goals on the same repo below the duplicate threshold", () => {
    expect(
      goalSimilarity(
        "eliza 레포에 로그인 버튼 추가",
        "eliza 레포의 테스트 실패 고치기",
      ),
    ).toBeLessThan(THRESHOLD);
  });

  it("scores a Korean restatement of the same goal as a duplicate", () => {
    expect(
      goalSimilarity(
        "eliza 레포에 로그인 버튼 추가",
        "eliza 레포에 로그인 버튼 추가해줘",
      ),
    ).toBeGreaterThanOrEqual(THRESHOLD);
  });

  it("scores English goals as before", () => {
    expect(
      goalSimilarity(
        "add a login button to the eliza repo",
        "fix the failing tests in the eliza repo",
      ),
    ).toBe(0.5);
    expect(
      goalSimilarity(
        "Build the Nubs mechanical keyboard site",
        "Nubs mechanical keyboard site build",
      ),
    ).toBe(1);
  });
});

describe("findNearDuplicateInFlightWork", () => {
  const runtime = { getService: () => null } as unknown as IAgentRuntime;
  const inFlight = (title: string, originalRequest: string) =>
    ({
      listTasks: async () => [{ title, originalRequest, status: "active" }],
    }) as unknown as OrchestratorTaskService;

  it("lets a request for a different deliverable through", async () => {
    for (const [existing, request] of [
      [
        "Fix the failing tests in the billing module",
        "Fix the failing tests in the auth module",
      ],
      [
        "Add pagination to the settings page",
        "Add dark mode to the settings page",
      ],
      [
        "Build a landing page for the gym with pricing and contact form",
        "Build a landing page for my bakery with a menu and contact form",
      ],
    ]) {
      expect(goalSimilarity(request, existing)).toBeGreaterThanOrEqual(
        THRESHOLD,
      );
      await expect(
        findNearDuplicateInFlightWork({
          runtime,
          taskService: inFlight(existing, existing),
          candidateText: `${request} ${request}`,
          userText: request,
        }),
        request,
      ).resolves.toBeUndefined();
    }
  });

  it("still reports a follow-up about the in-flight work as a duplicate", async () => {
    for (const userText of [
      "so is my site done?? where can i see it",
      "is the site done?",
      "can you check the site?",
      "is the build for my shop done?",
    ]) {
      await expect(
        findNearDuplicateInFlightWork({
          runtime,
          taskService: inFlight(
            "Nubs mechanical keyboard site",
            "build me a site for my Nubs mechanical keyboard shop",
          ),
          candidateText:
            "Nubs keyboard site Build the Nubs mechanical keyboard site",
          userText,
        }),
        userText,
      ).resolves.toEqual({
        name: '"Nubs mechanical keyboard site"',
        status: "active",
      });
    }
  });
});
