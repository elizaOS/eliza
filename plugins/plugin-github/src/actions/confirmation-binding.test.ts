/**
 * GitHub write ops drive the real issue and PR handlers through the real
 * `requireConfirmation` gate with a cache-backed runtime: a yes confirms only
 * the request that was previewed, and a review GitHub would reject for a
 * missing body is refused before the prompt.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { GitHubOctokitClient } from "../types.js";
import { issueOpAction } from "./issue-op.js";
import { prOpAction } from "./pr-op.js";

const OWNER_ENTITY_ID = "00000000-0000-0000-0000-00000000user";

function createRuntime(octokit: GitHubOctokitClient): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: "00000000-0000-0000-0000-00000000agent",
    getService: () => ({
      getOctokit: () => octokit,
      // "owner-gh" is the owner's personal account under a custom id.
      getAccountRole: (selection: { role: string; accountId?: string }) =>
        selection.accountId === "owner-gh" ? "user" : selection.role,
    }),
    getSetting: (key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER_ENTITY_ID : null,
    reportError: vi.fn(),
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
    deleteCache: async (key: string) => cache.delete(key),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
}

function userTurn(text: string): Memory {
  return {
    entityId: OWNER_ENTITY_ID,
    content: { text },
  } as unknown as Memory;
}

function memberTurn(text: string): Memory {
  return {
    entityId: "00000000-0000-0000-0000-0000000member",
    content: { text, source: "api" },
  } as unknown as Memory;
}

describe("GitHub write confirmation", () => {
  it("previews a changed issue comment instead of posting it on yes", async () => {
    const createComment = vi.fn().mockResolvedValue({
      data: { id: 9, html_url: "https://github.test/a/b/issues/5#c9" },
    });
    const runtime = createRuntime({
      issues: { createComment },
    } as unknown as GitHubOctokitClient);
    const prompts: string[] = [];
    const callback = async (content: { text?: string }) => {
      prompts.push(content.text ?? "");
      return [];
    };
    const previewed = {
      op: "comment",
      repo: "a/b",
      number: 5,
      body: "Looks good, merging.",
    };

    await issueOpAction.handler(
      runtime,
      userTurn("comment on a/b#5"),
      undefined,
      previewed,
      callback,
    );
    const changed = await issueOpAction.handler(
      runtime,
      userTurn("yes"),
      undefined,
      { ...previewed, body: "Completely different text." },
      callback,
    );

    expect(createComment).not.toHaveBeenCalled();
    expect(changed).toMatchObject({ requiresConfirmation: true });
    expect(prompts.at(-1)).toContain("Completely different text.");

    await issueOpAction.handler(
      runtime,
      userTurn("yes"),
      undefined,
      { ...previewed, body: "Completely different text." },
      callback,
    );

    expect(createComment).toHaveBeenCalledTimes(1);
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 5,
        body: "Completely different text.",
      }),
    );
  });

  it("does not close another issue on a yes given for the previewed one", async () => {
    const update = vi.fn().mockResolvedValue({ data: { title: "t" } });
    const runtime = createRuntime({
      issues: { update },
    } as unknown as GitHubOctokitClient);

    await issueOpAction.handler(runtime, userTurn("close a/b#5"), undefined, {
      op: "close",
      repo: "a/b",
      number: 5,
    });
    await issueOpAction.handler(runtime, userTurn("yes"), undefined, {
      op: "close",
      repo: "a/b",
      number: 99,
    });

    expect(update).not.toHaveBeenCalled();
  });

  it("does not submit a review whose body changed after the preview", async () => {
    const createReview = vi.fn().mockResolvedValue({ data: { id: 3 } });
    const runtime = createRuntime({
      pulls: { createReview },
    } as unknown as GitHubOctokitClient);
    const review = {
      op: "review",
      repo: "a/b",
      number: 42,
      review_action: "approve",
    };

    await prOpAction.handler(runtime, userTurn("approve"), undefined, {
      ...review,
      body: "A",
    });
    await prOpAction.handler(runtime, userTurn("yes"), undefined, {
      ...review,
      body: "B different",
    });
    expect(createReview).not.toHaveBeenCalled();

    await prOpAction.handler(runtime, userTurn("yes"), undefined, {
      ...review,
      body: "B different",
    });
    expect(createReview).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 42, body: "B different" }),
    );
  });

  it("rejects a comment review without a body before asking to confirm", async () => {
    const createReview = vi.fn();
    const runtime = createRuntime({
      pulls: { createReview },
    } as unknown as GitHubOctokitClient);
    const prompts: string[] = [];

    const result = await prOpAction.handler(
      runtime,
      userTurn("comment on the PR"),
      undefined,
      { op: "review", repo: "a/b", number: 42, review_action: "comment" },
      async (content: { text?: string }) => {
        prompts.push(content.text ?? "");
        return [];
      },
    );

    expect(result).toMatchObject({
      success: false,
      error: "comment review requires a body",
    });
    expect(prompts).toEqual(["comment review requires a body"]);
    expect(createReview).not.toHaveBeenCalled();
  });

  it("reports assignees GitHub silently ignored instead of claiming them", async () => {
    // GitHub answers 201 and ignores assignees the caller may not set.
    const addAssignees = vi.fn().mockResolvedValue({
      data: { assignees: [{ login: "alice" }] },
    });
    const runtime = createRuntime({
      issues: { addAssignees },
    } as unknown as GitHubOctokitClient);
    const request = {
      op: "assign",
      repo: "a/b",
      number: 5,
      assignees: ["bob"],
    };

    await issueOpAction.handler(
      runtime,
      userTurn("assign bob"),
      undefined,
      request,
    );
    const result = await issueOpAction.handler(
      runtime,
      userTurn("yes"),
      undefined,
      request,
    );

    expect(addAssignees).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: false });
    expect(result && "error" in result ? result.error : "").toContain("[bob]");
  });

  it("does not approve a pull request as the owner for a sender who is not the owner", async () => {
    const createReview = vi.fn().mockResolvedValue({ data: { id: 3 } });
    const runtime = createRuntime({
      pulls: { createReview },
    } as unknown as GitHubOctokitClient);
    const review = {
      op: "review",
      repo: "a/b",
      number: 42,
      review_action: "approve",
    };

    const asked = await prOpAction.handler(
      runtime,
      memberTurn("approve a/b#42"),
      undefined,
      review,
    );
    await prOpAction.handler(runtime, memberTurn("yes"), undefined, review);

    expect(asked).toMatchObject({
      success: false,
      error:
        "Only the owner can use their own GitHub account. Nothing was done.",
    });
    expect(createReview).not.toHaveBeenCalled();
  });

  it("names the owner's account in the preview when the owner selects it by account id", async () => {
    const createComment = vi.fn();
    const runtime = createRuntime({
      issues: { createComment },
    } as unknown as GitHubOctokitClient);
    const prompts: string[] = [];

    await issueOpAction.handler(
      runtime,
      userTurn("comment on a/b#5"),
      undefined,
      {
        op: "comment",
        repo: "a/b",
        number: 5,
        body: "LGTM",
        as: "agent",
        accountId: "owner-gh",
      },
      async (content: { text?: string }) => {
        prompts.push(content.text ?? "");
        return [];
      },
    );

    expect(prompts.at(-1)).toContain("as user (owner-gh).");
    expect(createComment).not.toHaveBeenCalled();
  });

  it("does not comment as the owner's account selected by account id for a sender who is not the owner", async () => {
    const createComment = vi.fn().mockResolvedValue({
      data: { id: 9, html_url: "https://github.test/a/b/issues/5#c9" },
    });
    const runtime = createRuntime({
      issues: { createComment },
    } as unknown as GitHubOctokitClient);
    const request = {
      op: "comment",
      repo: "a/b",
      number: 5,
      body: "LGTM",
      as: "agent",
      accountId: "owner-gh",
    };

    await issueOpAction.handler(
      runtime,
      memberTurn("comment on a/b#5"),
      undefined,
      request,
    );
    await issueOpAction.handler(runtime, memberTurn("yes"), undefined, request);

    expect(createComment).not.toHaveBeenCalled();
  });
});
