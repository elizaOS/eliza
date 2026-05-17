export interface GitHubFixtureRequest {
  action: string;
  params: Record<string, unknown>;
  createdAt: string;
}

export interface GitHubFixturePullRequest {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user: { login: string };
}

export interface GitHubFixtureSearchItem extends GitHubFixturePullRequest {
  repository_url: string;
}

export interface GitHubFixtureNotification {
  id: string;
  reason: string;
  repository: { full_name: string; pushed_at: string };
  subject: { title: string; type: string; url: string };
  updated_at: string;
}

export interface GitHubOctokitFixtureClient {
  activity: {
    listNotificationsForAuthenticatedUser: (
      params?: Record<string, unknown>,
    ) => Promise<{ data: GitHubFixtureNotification[] }>;
  };
  issues: {
    addAssignees: (
      params: Record<string, unknown>,
    ) => Promise<{ data: { assignees: Array<{ login: string }> } }>;
    create: (
      params: Record<string, unknown>,
    ) => Promise<{ data: { number: number; html_url: string } }>;
  };
  pulls: {
    createReview: (
      params: Record<string, unknown>,
    ) => Promise<{ data: { id: number } }>;
    list: (
      params: Record<string, unknown>,
    ) => Promise<{ data: GitHubFixturePullRequest[] }>;
  };
  search: {
    issuesAndPullRequests: (
      params: Record<string, unknown>,
    ) => Promise<{ data: { items: GitHubFixtureSearchItem[] } }>;
  };
}

export interface GitHubOctokitFixture {
  client: GitHubOctokitFixtureClient;
  requests: GitHubFixtureRequest[];
  clearRequests(): void;
}

export const GITHUB_FIXTURE_PULLS: GitHubFixturePullRequest[] = [
  {
    number: 17,
    title: "Centralize LifeOps connector mocks",
    state: "open",
    html_url: "https://github.com/elizaOS/eliza/pull/17",
    user: { login: "alice" },
  },
  {
    number: 12,
    title: "Tighten notification scoring",
    state: "closed",
    html_url: "https://github.com/elizaOS/eliza/pull/12",
    user: { login: "bob" },
  },
];

export const GITHUB_FIXTURE_SEARCH_ITEMS: GitHubFixtureSearchItem[] =
  GITHUB_FIXTURE_PULLS.map((pull) => ({
    ...pull,
    repository_url: "https://api.github.com/repos/elizaOS/eliza",
  }));

export const GITHUB_FIXTURE_NOTIFICATIONS: GitHubFixtureNotification[] = [
  {
    id: "thread-review-requested",
    reason: "review_requested",
    repository: {
      full_name: "elizaOS/eliza",
      pushed_at: "2026-04-25T18:00:00.000Z",
    },
    subject: {
      title: "Centralize LifeOps connector mocks",
      type: "PullRequest",
      url: "https://api.github.com/repos/elizaOS/eliza/pulls/17",
    },
    updated_at: "2026-04-25T19:00:00.000Z",
  },
  {
    id: "thread-subscribed",
    reason: "subscribed",
    repository: {
      full_name: "elizaOS/eliza",
      pushed_at: "2026-04-17T18:00:00.000Z",
    },
    subject: {
      title: "Older subscribed issue",
      type: "Issue",
      url: "https://api.github.com/repos/elizaOS/eliza/issues/4",
    },
    updated_at: "2026-04-18T19:00:00.000Z",
  },
];

function record(
  requests: GitHubFixtureRequest[],
  action: string,
  params: Record<string, unknown> = {},
): void {
  requests.push({
    action,
    params,
    createdAt: new Date().toISOString(),
  });
}

function stringParam(
  params: Record<string, unknown>,
  key: string,
): string | null {
  const value = params[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function numberParam(
  params: Record<string, unknown>,
  key: string,
): number | null {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArrayParam(
  params: Record<string, unknown>,
  key: string,
): string[] {
  const value = params[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function createGitHubOctokitFixture(): GitHubOctokitFixture {
  const requests: GitHubFixtureRequest[] = [];

  return {
    requests,
    clearRequests() {
      requests.splice(0, requests.length);
    },
    client: {
      activity: {
        async listNotificationsForAuthenticatedUser(params = {}) {
          record(
            requests,
            "activity.listNotificationsForAuthenticatedUser",
            params,
          );
          return {
            data: GITHUB_FIXTURE_NOTIFICATIONS.map((item) => ({ ...item })),
          };
        },
      },
      issues: {
        async addAssignees(params) {
          record(requests, "issues.addAssignees", params);
          const assignees = stringArrayParam(params, "assignees").map(
            (login) => ({ login }),
          );
          return { data: { assignees } };
        },
        async create(params) {
          record(requests, "issues.create", params);
          const owner = stringParam(params, "owner") ?? "elizaOS";
          const repo = stringParam(params, "repo") ?? "eliza";
          const number = 101;
          return {
            data: {
              number,
              html_url: `https://github.com/${owner}/${repo}/issues/${number}`,
            },
          };
        },
      },
      pulls: {
        async createReview(params) {
          record(requests, "pulls.createReview", params);
          return {
            data: { id: numberParam(params, "pull_number") ?? 777 },
          };
        },
        async list(params) {
          record(requests, "pulls.list", params);
          const state = stringParam(params, "state") ?? "open";
          const data = GITHUB_FIXTURE_PULLS.filter(
            (pull) => state === "all" || pull.state === state,
          );
          return {
            data: data.map((pull) => ({ ...pull, user: { ...pull.user } })),
          };
        },
      },
      search: {
        async issuesAndPullRequests(params) {
          record(requests, "search.issuesAndPullRequests", params);
          return {
            data: {
              items: GITHUB_FIXTURE_SEARCH_ITEMS.map((item) => ({
                ...item,
                user: { ...item.user },
              })),
            },
          };
        },
      },
    },
  };
}
