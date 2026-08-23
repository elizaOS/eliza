/**
 * Pins the GitHub bug-report title bound by driving the real
 * `handleBugReportRoutes` POST path with a captured `fetch`: the `[Bug] `
 * prefix is added after truncation, so the truncation budget must account for
 * it or the issue title silently grows past the documented 80-char cap.
 * Deterministic — no network, GitHub is a captured fetch stub.
 */
import { EventEmitter } from "node:events";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handleBugReportRoutes,
  resetBugReportRateLimit,
} from "./bug-report-routes.ts";

const GITHUB_TITLE_MAX_LEN = 80;

function makeRequest(): http.IncomingMessage {
  const req = new EventEmitter() as unknown as {
    aborted: boolean;
    socket: { remoteAddress: string };
  };
  req.aborted = false;
  req.socket = { remoteAddress: "127.0.0.1" };
  return req as unknown as http.IncomingMessage;
}

async function postBugReport(description: string): Promise<{
  title: string;
  responses: unknown[];
}> {
  const capturedTitles: string[] = [];
  const responses: unknown[] = [];
  const errors: string[] = [];

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as { title: string };
    capturedTitles.push(payload.title);
    return Response.json({
      html_url: "https://github.com/elizaOS/eliza/issues/1",
    });
  }) as unknown as typeof fetch;

  try {
    const handled = await handleBugReportRoutes({
      req: makeRequest(),
      res: {} as http.ServerResponse,
      method: "POST",
      pathname: "/api/bug-report",
      json: (_res, data) => {
        responses.push(data);
      },
      error: (_res, message) => {
        errors.push(message);
      },
      readJsonBody: async () =>
        ({
          description,
          stepsToReproduce: "run the app",
        }) as never,
    });
    expect(handled).toBe(true);
  } finally {
    globalThis.fetch = previousFetch;
  }

  expect(errors).toEqual([]);
  expect(capturedTitles).toHaveLength(1);
  return { title: capturedTitles[0] as string, responses };
}

describe("GitHub bug-report title bound", () => {
  const previousToken = process.env.GITHUB_TOKEN;
  const previousRemote = process.env.ELIZA_BUG_REPORT_API_URL;
  const previousRepo = process.env.ELIZA_BUG_REPORT_REPO;

  beforeEach(() => {
    process.env.GITHUB_TOKEN = "test-token";
    delete process.env.ELIZA_BUG_REPORT_API_URL;
    delete process.env.ELIZA_BUG_REPORT_REPO;
    resetBugReportRateLimit();
  });

  afterEach(() => {
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
    if (previousRemote === undefined)
      delete process.env.ELIZA_BUG_REPORT_API_URL;
    else process.env.ELIZA_BUG_REPORT_API_URL = previousRemote;
    if (previousRepo === undefined) delete process.env.ELIZA_BUG_REPORT_REPO;
    else process.env.ELIZA_BUG_REPORT_REPO = previousRepo;
    resetBugReportRateLimit();
  });

  it("keeps the posted title (prefix included) within 80 chars", async () => {
    const { title } = await postBugReport("x".repeat(120));

    expect(title.startsWith("[Bug] ")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(GITHUB_TITLE_MAX_LEN);
    expect(title).toBe(
      `[Bug] ${"x".repeat(GITHUB_TITLE_MAX_LEN - "[Bug] ".length)}`,
    );
  });

  it("posts short descriptions unchanged (no over-trimming)", async () => {
    const { title, responses } = await postBugReport("crash on startup");

    expect(title).toBe("[Bug] crash on startup");
    expect(title.length).toBeLessThanOrEqual(GITHUB_TITLE_MAX_LEN);
    expect(responses).toEqual([
      { url: "https://github.com/elizaOS/eliza/issues/1" },
    ]);
  });
});
