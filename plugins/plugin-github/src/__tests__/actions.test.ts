/**
 * Unit tests for the 5 GitHub plugin actions.
 *
 * Strategy: build a stub Octokit (structurally typed via `as unknown as
 * Octokit` only at the boundary because the real Octokit type is massive
 * and we exercise a narrow surface). Inject it into GitHubService via
 * `setClientForTesting`, then drive the action handlers directly.
 *
 * Each action is checked for:
 *   - confirmation gate (for destructive actions)
 *   - success path returning the expected `data`
 *   - rate-limit detection
 */

import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import type { Action, IAgentRuntime } from "@elizaos/core";
import { assignIssueAction } from "../actions/assign-issue.js";
import { createIssueAction } from "../actions/create-issue.js";
import { listPrsAction } from "../actions/list-prs.js";
import {
	notificationTriageAction,
	scoreNotification,
} from "../actions/notification-triage.js";
import { reviewPrAction } from "../actions/review-pr.js";
import { GitHubService } from "../services/github-service.js";
import { GITHUB_SERVICE_TYPE } from "../types.js";

interface StubOctokit {
	pulls: {
		list: ReturnType<typeof vi.fn>;
		createReview: ReturnType<typeof vi.fn>;
	};
	search: { issuesAndPullRequests: ReturnType<typeof vi.fn> };
	issues: {
		create: ReturnType<typeof vi.fn>;
		addAssignees: ReturnType<typeof vi.fn>;
	};
	activity: {
		listNotificationsForAuthenticatedUser: ReturnType<typeof vi.fn>;
	};
}

function buildStubOctokit(): StubOctokit {
	return {
		pulls: { list: vi.fn(), createReview: vi.fn() },
		search: { issuesAndPullRequests: vi.fn() },
		issues: { create: vi.fn(), addAssignees: vi.fn() },
		activity: { listNotificationsForAuthenticatedUser: vi.fn() },
	};
}

function buildRuntime(service: GitHubService): IAgentRuntime {
	const runtime = {
		agentId: "test-agent",
		getService: (type: string) => (type === GITHUB_SERVICE_TYPE ? service : null),
		getSetting: () => undefined,
	};
	return runtime as unknown as IAgentRuntime;
}

async function buildServiceWithClient(
	stub: StubOctokit,
	identity: "user" | "agent" = "agent",
): Promise<{ service: GitHubService; runtime: IAgentRuntime }> {
	const bootstrapRuntime = {
		agentId: "test-agent",
		getSetting: () => undefined,
	} as unknown as IAgentRuntime;
	const service = new GitHubService(bootstrapRuntime);
	service.setClientForTesting(identity, stub as unknown as Octokit);
	const runtime = buildRuntime(service);
	return { service, runtime };
}

async function runHandler(
	action: Action,
	runtime: IAgentRuntime,
	options: Record<string, unknown>,
): Promise<unknown> {
	const callback = vi.fn(async () => []);
	const result = await action.handler(
		runtime,
		{ id: "m", entityId: "e", roomId: "r", content: { text: "" } } as never,
		undefined,
		options as never,
		callback,
	);
	return result;
}

describe("LIST_PRS", () => {
	it("lists PRs for a specific repo and respects author filter", async () => {
		const stub = buildStubOctokit();
		stub.pulls.list.mockResolvedValue({
			data: [
				{
					number: 1,
					title: "A",
					state: "open",
					html_url: "u1",
					user: { login: "alice" },
				},
				{
					number: 2,
					title: "B",
					state: "open",
					html_url: "u2",
					user: { login: "bob" },
				},
			],
		});
		const { runtime } = await buildServiceWithClient(stub, "agent");
		const result = (await runHandler(listPrsAction, runtime, {
			repo: "o/r",
			author: "alice",
		})) as { success: boolean; data: { prs: unknown[] } };
		expect(result.success).toBe(true);
		expect(result.data.prs).toHaveLength(1);
	});

	it("falls back to cross-repo search when no repo is given", async () => {
		const stub = buildStubOctokit();
		stub.search.issuesAndPullRequests.mockResolvedValue({
			data: {
				items: [
					{
						number: 9,
						title: "X",
						state: "open",
						html_url: "u9",
						user: { login: "c" },
						repository_url: "https://api.github.com/repos/o/r",
					},
				],
			},
		});
		const { runtime } = await buildServiceWithClient(stub, "agent");
		const result = (await runHandler(listPrsAction, runtime, {})) as {
			success: boolean;
			data: { prs: { repo: string }[] };
		};
		expect(result.success).toBe(true);
		expect(result.data.prs[0].repo).toBe("o/r");
	});

	it("returns clean rate-limit error when GitHub returns 403", async () => {
		const stub = buildStubOctokit();
		stub.pulls.list.mockRejectedValue({
			status: 403,
			response: {
				headers: {
					"x-ratelimit-remaining": "0",
					"x-ratelimit-reset": "1700000000",
				},
			},
			message: "rate limited",
		});
		const { runtime } = await buildServiceWithClient(stub, "agent");
		const result = (await runHandler(listPrsAction, runtime, {
			repo: "o/r",
		})) as { success: false; error: string };
		expect(result.success).toBe(false);
		expect(result.error).toContain("rate limit");
	});
});

describe("REVIEW_PR", () => {
	it("requires confirmation for approve", async () => {
		const stub = buildStubOctokit();
		const { runtime } = await buildServiceWithClient(stub, "user");
		const result = (await runHandler(reviewPrAction, runtime, {
			repo: "o/r",
			number: 1,
			action: "approve",
		})) as { success: false; requiresConfirmation?: boolean };
		expect(result.success).toBe(false);
		expect(result.requiresConfirmation).toBe(true);
		expect(stub.pulls.createReview).not.toHaveBeenCalled();
	});

	it("requires confirmation for request-changes", async () => {
		const stub = buildStubOctokit();
		const { runtime } = await buildServiceWithClient(stub, "user");
		const result = (await runHandler(reviewPrAction, runtime, {
			repo: "o/r",
			number: 1,
			action: "request-changes",
			body: "please fix",
		})) as { success: false; requiresConfirmation?: boolean };
		expect(result.requiresConfirmation).toBe(true);
	});

	it("submits review when confirmed", async () => {
		const stub = buildStubOctokit();
		stub.pulls.createReview.mockResolvedValue({ data: { id: 777 } });
		const { runtime } = await buildServiceWithClient(stub, "user");
		const result = (await runHandler(reviewPrAction, runtime, {
			repo: "o/r",
			number: 1,
			action: "approve",
			confirmed: true,
		})) as { success: true; data: { id: number } };
		expect(result.success).toBe(true);
		expect(result.data.id).toBe(777);
		expect(stub.pulls.createReview).toHaveBeenCalledWith(
			expect.objectContaining({ event: "APPROVE", pull_number: 1 }),
		);
	});

	it("rejects missing params", async () => {
		const stub = buildStubOctokit();
		const { runtime } = await buildServiceWithClient(stub, "user");
		const result = (await runHandler(reviewPrAction, runtime, {
			action: "comment",
		})) as { success: false; error: string };
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/requires/);
	});
});

describe("CREATE_ISSUE", () => {
	it("requires confirmation", async () => {
		const stub = buildStubOctokit();
		const { runtime } = await buildServiceWithClient(stub, "agent");
		const result = (await runHandler(createIssueAction, runtime, {
			repo: "o/r",
			title: "bug",
		})) as { requiresConfirmation?: boolean };
		expect(result.requiresConfirmation).toBe(true);
		expect(stub.issues.create).not.toHaveBeenCalled();
	});

	it("creates issue when confirmed", async () => {
		const stub = buildStubOctokit();
		stub.issues.create.mockResolvedValue({
			data: { number: 42, html_url: "https://gh/o/r/42" },
		});
		const { runtime } = await buildServiceWithClient(stub, "agent");
		const result = (await runHandler(createIssueAction, runtime, {
			repo: "o/r",
			title: "bug",
			body: "broken",
			labels: ["bug"],
			confirmed: true,
		})) as { success: true; data: { number: number; url: string } };
		expect(result.success).toBe(true);
		expect(result.data.number).toBe(42);
	});
});

describe("ASSIGN_ISSUE", () => {
	it("requires confirmation", async () => {
		const stub = buildStubOctokit();
		const { runtime } = await buildServiceWithClient(stub, "agent");
		const result = (await runHandler(assignIssueAction, runtime, {
			repo: "o/r",
			number: 5,
			assignees: ["alice"],
		})) as { requiresConfirmation?: boolean };
		expect(result.requiresConfirmation).toBe(true);
		expect(stub.issues.addAssignees).not.toHaveBeenCalled();
	});

	it("assigns when confirmed", async () => {
		const stub = buildStubOctokit();
		stub.issues.addAssignees.mockResolvedValue({
			data: { assignees: [{ login: "alice" }, { login: "bob" }] },
		});
		const { runtime } = await buildServiceWithClient(stub, "agent");
		const result = (await runHandler(assignIssueAction, runtime, {
			repo: "o/r",
			number: 5,
			assignees: ["alice", "bob"],
			confirmed: true,
		})) as { success: true; data: { assignees: string[] } };
		expect(result.success).toBe(true);
		expect(result.data.assignees).toEqual(["alice", "bob"]);
	});

	it("rejects empty assignee list", async () => {
		const stub = buildStubOctokit();
		const { runtime } = await buildServiceWithClient(stub, "agent");
		const result = (await runHandler(assignIssueAction, runtime, {
			repo: "o/r",
			number: 5,
			assignees: [],
			confirmed: true,
		})) as { success: false; error: string };
		expect(result.success).toBe(false);
	});
});

describe("GITHUB_NOTIFICATION_TRIAGE", () => {
	it("sorts notifications by score", async () => {
		const stub = buildStubOctokit();
		const nowIso = new Date().toISOString();
		stub.activity.listNotificationsForAuthenticatedUser.mockResolvedValue({
			data: [
				{
					id: "1",
					reason: "subscribed",
					repository: {
						full_name: "o/r",
						pushed_at: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(),
					},
					subject: { title: "old", type: "Issue", url: null },
					updated_at: nowIso,
				},
				{
					id: "2",
					reason: "review_requested",
					repository: { full_name: "o/r", pushed_at: nowIso },
					subject: { title: "hot", type: "PullRequest", url: null },
					updated_at: nowIso,
				},
			],
		});
		const { runtime } = await buildServiceWithClient(stub, "user");
		const result = (await runHandler(
			notificationTriageAction,
			runtime,
			{},
		)) as {
			success: true;
			data: { notifications: { id: string; score: number }[] };
		};
		expect(result.success).toBe(true);
		expect(result.data.notifications[0].id).toBe("2");
		expect(result.data.notifications[0].score).toBeGreaterThan(
			result.data.notifications[1].score,
		);
	});

	it("scoreNotification reflects reason + freshness", () => {
		const now = Date.now();
		const fresh = scoreNotification({
			reason: "security_advisory",
			subjectType: "PullRequest",
			repoPushedAtMs: now,
			nowMs: now,
		});
		const stale = scoreNotification({
			reason: "subscribed",
			subjectType: "Issue",
			repoPushedAtMs: now - 30 * 24 * 3600 * 1000,
			nowMs: now,
		});
		expect(fresh).toBeGreaterThan(stale);
	});
});

describe("service gating", () => {
	it("returns error when identity has no configured token", async () => {
		const bootstrapRuntime = {
			agentId: "a",
			getSetting: () => undefined,
		} as unknown as IAgentRuntime;
		const service = new GitHubService(bootstrapRuntime);
		const runtime = buildRuntime(service);
		const result = (await runHandler(listPrsAction, runtime, {
			repo: "o/r",
		})) as { success: false; error: string };
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/token not configured/);
	});
});
