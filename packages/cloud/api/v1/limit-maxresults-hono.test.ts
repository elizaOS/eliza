/**
 * Exercises the five Gmail and X `maxResults` query boundaries through their
 * real Hono applications while replacing only authentication and external
 * connector calls. Malformed values must fail before any provider service is
 * invoked; valid, missing, and blank values preserve each route's contract.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "00000000-0000-4000-8000-000000000002",
  organization_id: "00000000-0000-4000-8000-000000000001",
}));

const fetchManagedGoogleGmailTriage = mock(async () => ({ messages: [] }));
const fetchManagedGoogleGmailSearch = mock(async () => ({ messages: [] }));
const fetchManagedGoogleGmailSubscriptionHeaders = mock(async () => ({
  headers: [],
}));
const getXFeed = mock(async () => ({ feed: [] }));
const getXDmDigest = mock(async () => ({ digest: [] }));

class MockXServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (_context: unknown, error: unknown) => {
    throw error;
  },
}));
mock.module("@/lib/services/agent-google-connector", () => ({
  AgentGoogleConnectorError: class AgentGoogleConnectorError extends Error {
    constructor(
      message: string,
      readonly status = 400,
    ) {
      super(message);
    }
  },
  fetchManagedGoogleGmailTriage,
  fetchManagedGoogleGmailSearch,
  fetchManagedGoogleGmailSubscriptionHeaders,
}));
mock.module("@/lib/services/x", () => ({
  XServiceError: MockXServiceError,
  getXFeed,
  getXDmDigest,
}));

const { default: triageApp } = await import(
  "./eliza/google/gmail/triage/route"
);
const { default: searchApp } = await import(
  "./eliza/google/gmail/search/route"
);
const { default: subscriptionHeadersApp } = await import(
  "./eliza/google/gmail/subscription-headers/route"
);
const { default: xFeedApp } = await import("./x/feed/route");
const { default: xDigestApp } = await import("./x/dms/digest/route");

type RouteApp = {
  request(path: string, init?: RequestInit): Response | Promise<Response>;
};

interface RouteCase {
  name: string;
  app: RouteApp;
  baseQuery: URLSearchParams;
  call: ReturnType<typeof mock>;
  fallback?: number;
  errorShape: { success?: false; error: string };
}

const routeCases: RouteCase[] = [
  {
    name: "Gmail triage",
    app: triageApp,
    baseQuery: new URLSearchParams(),
    call: fetchManagedGoogleGmailTriage,
    fallback: 12,
    errorShape: { error: "maxResults must be a positive integer." },
  },
  {
    name: "Gmail search",
    app: searchApp,
    baseQuery: new URLSearchParams({ query: "hello" }),
    call: fetchManagedGoogleGmailSearch,
    fallback: 12,
    errorShape: { error: "maxResults must be a positive integer." },
  },
  {
    name: "Gmail subscription headers",
    app: subscriptionHeadersApp,
    baseQuery: new URLSearchParams({ query: "hello" }),
    call: fetchManagedGoogleGmailSubscriptionHeaders,
    fallback: 200,
    errorShape: { error: "maxResults must be a positive integer." },
  },
  {
    name: "X feed",
    app: xFeedApp,
    baseQuery: new URLSearchParams(),
    call: getXFeed,
    errorShape: {
      success: false,
      error: "maxResults must be a positive integer",
    },
  },
  {
    name: "X DM digest",
    app: xDigestApp,
    baseQuery: new URLSearchParams(),
    call: getXDmDigest,
    errorShape: {
      success: false,
      error: "maxResults must be a positive integer",
    },
  },
];

const malformedValues = [
  "5junk",
  "1e4",
  "0",
  "-5",
  "+5",
  "5.5",
  "9007199254740993",
] as const;

function pathFor(testCase: RouteCase, maxResults?: string): string {
  const query = new URLSearchParams(testCase.baseQuery);
  if (maxResults !== undefined) query.set("maxResults", maxResults);
  const serialized = query.toString();
  return serialized ? `/?${serialized}` : "/";
}

function forwardedMaxResults(testCase: RouteCase): number | undefined {
  const firstCall = testCase.call.mock.calls[0];
  const input = firstCall?.[0] as { maxResults?: number } | undefined;
  return input?.maxResults;
}

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockClear();
  for (const testCase of routeCases) testCase.call.mockClear();
});

for (const testCase of routeCases) {
  describe(`${testCase.name} maxResults`, () => {
    for (const malformed of malformedValues) {
      test(`rejects ${JSON.stringify(malformed)} before the connector`, async () => {
        const response = await testCase.app.request(
          pathFor(testCase, malformed),
        );

        expect(response.status).toBe(400);
        const body = (await response.json()) as {
          success?: false;
          error: string;
        };
        expect(body).toEqual(testCase.errorShape);
        expect(testCase.call).not.toHaveBeenCalled();
      });
    }

    test("forwards a valid positive integer", async () => {
      const response = await testCase.app.request(pathFor(testCase, "20"));

      expect(response.status).toBe(200);
      expect(testCase.call).toHaveBeenCalledTimes(1);
      expect(forwardedMaxResults(testCase)).toBe(20);
    });

    test("preserves the missing-value contract", async () => {
      const response = await testCase.app.request(pathFor(testCase));

      expect(response.status).toBe(200);
      expect(forwardedMaxResults(testCase)).toBe(testCase.fallback);
    });

    test("treats a blank value like a missing value", async () => {
      const response = await testCase.app.request(pathFor(testCase, ""));

      expect(response.status).toBe(200);
      expect(forwardedMaxResults(testCase)).toBe(testCase.fallback);
    });

    test("rejects whitespace-padded value via canonical integer", async () => {
      const response = await testCase.app.request(pathFor(testCase, " 20 "));

      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        success?: false;
        error: string;
      };
      expect(body).toEqual(testCase.errorShape);
      expect(testCase.call).not.toHaveBeenCalled();
    });
  });
}
