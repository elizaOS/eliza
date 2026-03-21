import os from "node:os";
import type { RouteRequestContext } from "./route-helpers";

export const BUG_REPORT_REPO = "elizaos/eliza";
const GITHUB_ISSUES_URL = `https://api.github.com/repos/${BUG_REPORT_REPO}/issues`;
const GITHUB_NEW_ISSUE_URL = `https://github.com/${BUG_REPORT_REPO}/issues/new?template=bug_report.yml`;

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
}

export function sanitize(input: string, maxLen = 10_000): string {
  return input.replace(/<[^>]*>/g, "").slice(0, maxLen);
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
    sections.push(`### Logs\n\n\`\`\`\n${sanitize(body.logs, 50_000)}\n\`\`\``);
  }
  return sections.join("\n\n");
}

export async function handleBugReportRoutes(
  ctx: RouteRequestContext,
): Promise<boolean> {
  const { req, res, method, pathname, json, error, readJsonBody } = ctx;

  if (method === "GET" && pathname === "/api/bug-report/info") {
    json(res, {
      nodeVersion: process.version,
      platform: os.platform(),
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

    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
      json(res, { fallback: GITHUB_NEW_ISSUE_URL });
      return true;
    }

    try {
      const sanitizedTitle = sanitize(body.description, 80).replace(
        /[\r\n]+/g,
        " ",
      );
      const issueBody = formatIssueBody(body);
      const issueRes = await fetch(GITHUB_ISSUES_URL, {
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
        !url.startsWith(`https://github.com/${BUG_REPORT_REPO}/issues/`)
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
