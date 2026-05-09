import os from "node:os";
import type { RouteRequestContext } from "@elizaos/shared";

export const DEFAULT_BUG_REPORT_REPO = "eliza-ai/eliza";
export const BUG_REPORT_REPO_ENV_KEY = "ELIZA_BUG_REPORT_REPO";
const BUG_REPORT_REPO_FALLBACK_ENV_KEY = "BUG_REPORT_REPO";

function sanitizeRepoName(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (!/^[\w.-]+\/[\w.-]+$/.test(trimmed)) return null;
  return trimmed;
}

export function resolveBugReportRepo(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    sanitizeRepoName(env[BUG_REPORT_REPO_ENV_KEY]) ??
    sanitizeRepoName(env[BUG_REPORT_REPO_FALLBACK_ENV_KEY]) ??
    DEFAULT_BUG_REPORT_REPO
  );
}

export const BUG_REPORT_REPO = resolveBugReportRepo();

function getGithubIssuesUrl(repo: string): string {
  return `https://api.github.com/repos/${repo}/issues`;
}

function getGithubNewIssueUrl(repo: string): string {
  return `https://github.com/${repo}/issues/new?template=bug_report.yml`;
}

const BUG_REPORT_WINDOW_MS = 10 * 60 * 1000;
const BUG_REPORT_MAX_SUBMISSIONS = 5;
const bugReportAttempts = new Map<string, { count: number; resetAt: number }>();

function sweepExpiredEntries(
  map: Map<string, { count: number; resetAt: number }>,
  now: number,
  threshold: number,
): void {
  if (map.size <= threshold) return;
  for (const [key, value] of map) {
    if (now > value.resetAt) map.delete(key);
  }
}

export function rateLimitBugReport(ip: string | null): boolean {
  const key = ip ?? "unknown";
  const now = Date.now();
  sweepExpiredEntries(bugReportAttempts, now, 100);
  const current = bugReportAttempts.get(key);
  if (!current || now > current.resetAt) {
    bugReportAttempts.set(key, {
      count: 1,
      resetAt: now + BUG_REPORT_WINDOW_MS,
    });
    return true;
  }
  if (current.count >= BUG_REPORT_MAX_SUBMISSIONS) return false;
  current.count += 1;
  return true;
}

export function resetBugReportRateLimit(): void {
  bugReportAttempts.clear();
}

interface BugReportBody {
  description: string;
  stepsToReproduce: string;
  expectedBehavior?: string;
  actualBehavior?: string;
  environment?: string;
  nodeVersion?: string;
  modelProvider?: string;
  logs?: string;
  category?: "general" | "startup-failure";
  appVersion?: string;
  releaseChannel?: string;
  startup?: {
    reason?: string;
    phase?: string;
    message?: string;
    detail?: string;
    status?: number;
    path?: string;
  };
}

export function sanitize(input: string, maxLen = 10_000): string {
  const clipped = input.length > maxLen ? input.slice(0, maxLen) : input;
  let prev = clipped;
  let next = prev.replace(/<[^<>]{0,1024}>/g, "");
  while (next !== prev) {
    prev = next;
    next = prev.replace(/<[^<>]{0,1024}>/g, "");
  }
  return next.replace(/[<>]/g, "").slice(0, maxLen);
}

function redactSecrets(input: string, maxLen = 10_000): string {
  const sanitized = sanitize(input, maxLen);
  return sanitized
    .replace(
      /\b(0x[a-fA-F0-9]{64}|[A-Za-z0-9+/]{80,}={0,2})\b/g,
      "[redacted-secret]",
    )
    .replace(
      /\b(sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
      "[redacted-token]",
    )
    .replace(
      /\b(mnemonic|private[_ -]?key|seed phrase)\b\s*[:=]\s*.+/gi,
      "$1: [redacted]",
    );
}

function formatIssueBody(body: BugReportBody): string {
  const sections: string[] = [];
  sections.push(`### Description\n\n${sanitize(body.description)}`);
  sections.push(`### Steps to Reproduce\n\n${sanitize(body.stepsToReproduce)}`);
  if (body.expectedBehavior) {
    sections.push(
      `### Expected Behavior\n\n${sanitize(body.expectedBehavior)}`,
    );
  }
  if (body.actualBehavior) {
    sections.push(`### Actual Behavior\n\n${sanitize(body.actualBehavior)}`);
  }
  if (body.environment) {
    sections.push(`### Environment\n\n${sanitize(body.environment, 200)}`);
  }
  if (body.nodeVersion) {
    sections.push(`### Node Version\n\n${sanitize(body.nodeVersion, 200)}`);
  }
  if (body.modelProvider) {
    sections.push(`### Model Provider\n\n${sanitize(body.modelProvider, 200)}`);
  }
  if (body.logs) {
    sections.push(
      `### Logs\n\n\`\`\`\n${redactSecrets(body.logs, 50_000)}\n\`\`\``,
    );
  }
  if (body.startup) {
    sections.push(
      `### Startup Context\n\n\`\`\`json\n${JSON.stringify(
        {
          reason: body.startup.reason,
          phase: body.startup.phase,
          status: body.startup.status,
          path: body.startup.path,
        },
        null,
        2,
      )}\n\`\`\``,
    );
  }
  return sections.join("\n\n");
}

function getBugReportMode(): "remote" | "github" | "fallback" {
  if (getRemoteBugReportUrl()) return "remote";
  if (process.env.GITHUB_TOKEN) return "github";
  return "fallback";
}

function getRemoteBugReportUrl(): string | undefined {
  return (
    process.env.ELIZA_BUG_REPORT_API_URL ??
    process.env.ELIZA_CLOUD_BUG_REPORT_URL
  );
}

function getRemoteBugReportToken(): string | undefined {
  return (
    process.env.ELIZA_BUG_REPORT_API_TOKEN ??
    process.env.ELIZA_CLOUD_BUG_REPORT_TOKEN
  );
}

async function submitToRemoteBugIntake(body: BugReportBody) {
  const remoteBugReportUrl = getRemoteBugReportUrl();
  if (!remoteBugReportUrl) return null;
  const payload = {
    source: "eliza-desktop",
    submittedAt: new Date().toISOString(),
    category: body.category ?? "general",
    description: sanitize(body.description, 500),
    stepsToReproduce: sanitize(body.stepsToReproduce, 10_000),
    expectedBehavior: body.expectedBehavior
      ? sanitize(body.expectedBehavior, 10_000)
      : undefined,
    actualBehavior: body.actualBehavior
      ? sanitize(body.actualBehavior, 10_000)
      : undefined,
    environment: body.environment ? sanitize(body.environment, 200) : undefined,
    nodeVersion: body.nodeVersion ? sanitize(body.nodeVersion, 200) : undefined,
    modelProvider: body.modelProvider
      ? sanitize(body.modelProvider, 200)
      : undefined,
    appVersion: body.appVersion ? sanitize(body.appVersion, 200) : undefined,
    releaseChannel: body.releaseChannel
      ? sanitize(body.releaseChannel, 200)
      : undefined,
    logs: body.logs ? redactSecrets(body.logs, 50_000) : undefined,
    startup: body.startup
      ? {
          reason: body.startup.reason
            ? sanitize(body.startup.reason, 120)
            : undefined,
          phase: body.startup.phase
            ? sanitize(body.startup.phase, 120)
            : undefined,
          message: body.startup.message
            ? redactSecrets(body.startup.message, 1_000)
            : undefined,
          detail: body.startup.detail
            ? redactSecrets(body.startup.detail, 10_000)
            : undefined,
          status: body.startup.status,
          path: body.startup.path
            ? sanitize(body.startup.path, 500)
            : undefined,
        }
      : undefined,
  };

  const response = await fetch(remoteBugReportUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(getRemoteBugReportToken()
        ? { Authorization: `Bearer ${getRemoteBugReportToken()}` }
        : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Remote intake error (${response.status})`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = (await response.json()) as {
      id?: string;
      url?: string;
      accepted?: boolean;
    };
    return {
      accepted: data.accepted ?? true,
      id: data.id,
      url: data.url,
      destination: "remote" as const,
    };
  }

  return { accepted: true, destination: "remote" as const };
}

export async function handleBugReportRoutes(
  ctx: RouteRequestContext,
): Promise<boolean> {
  const { req, res, method, pathname, json, error, readJsonBody } = ctx;
  const bugReportRepo = resolveBugReportRepo();
  const githubIssuesUrl = getGithubIssuesUrl(bugReportRepo);
  const githubNewIssueUrl = getGithubNewIssueUrl(bugReportRepo);

  if (method === "GET" && pathname === "/api/bug-report/info") {
    json(res, {
      nodeVersion: process.version,
      platform: os.platform(),
      submissionMode: getBugReportMode(),
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/bug-report") {
    if (!rateLimitBugReport(req.socket.remoteAddress ?? null)) {
      error(res, "Too many bug reports. Try again later.", 429);
      return true;
    }

    const body = await readJsonBody<BugReportBody>(req, res);
    if (!body) return true;

    if (!body.description?.trim() || !body.stepsToReproduce?.trim()) {
      error(res, "description and stepsToReproduce are required", 400);
      return true;
    }

    if (getRemoteBugReportUrl()) {
      try {
        const result = await submitToRemoteBugIntake(body);
        if (!result) {
          error(res, "Failed to submit bug report", 502);
          return true;
        }
        json(res, result);
      } catch {
        error(res, "Failed to submit bug report", 502);
      }
      return true;
    }

    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
      json(res, { fallback: githubNewIssueUrl });
      return true;
    }

    try {
      const sanitizedTitle = sanitize(body.description, 80).replace(
        /[\r\n]+/g,
        " ",
      );
      const issueBody = formatIssueBody(body);
      const issueRes = await fetch(githubIssuesUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: `[Bug] ${sanitizedTitle}`,
          body: issueBody,
          labels: ["bug", "triage", "user-reported"],
        }),
      });

      if (!issueRes.ok) {
        error(res, `GitHub API error (${issueRes.status})`, 502);
        return true;
      }

      const issueData = (await issueRes.json()) as { html_url?: string };
      const url = issueData.html_url;
      if (
        typeof url !== "string" ||
        !url.startsWith(`https://github.com/${bugReportRepo}/issues/`)
      ) {
        error(res, "Unexpected response from GitHub API", 502);
        return true;
      }
      json(res, { url });
    } catch {
      error(res, "Failed to create GitHub issue", 500);
    }
    return true;
  }

  return false;
}
