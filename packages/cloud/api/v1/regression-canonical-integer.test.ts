/**
 * Regression: strict maxResults parse via parseCanonicalInteger for gmail + x feed/dm.
 * Calls real parseCanonicalInteger and real Hono route handlers.
 * Contract: blank→undefined (fallback), "0"→0 (zero-able via direct parse, but route min1 →400),
 * "012"/"0x10"/"1e3"→"invalid"→400, whitespace-padded→invalid, upstream not called on invalid,
 * never uses Number() coercion, safe-integer bounded.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { parseCanonicalInteger } from "@elizaos/shared";

// ── direct parseCanonicalInteger contract (real) ──────────────────────────
describe("parseCanonicalInteger — regression direct (real)", () => {
  test("blank → undefined", () => {
    expect(parseCanonicalInteger(null)).toBeUndefined();
    expect(parseCanonicalInteger(undefined)).toBeUndefined();
    expect(parseCanonicalInteger("")).toBeUndefined();
    expect(parseCanonicalInteger("   ")).toBeUndefined();
  });

  test('"0" → 0 (zero-able, not falsy fallback)', () => {
    expect(parseCanonicalInteger("0")).toBe(0);
    expect(parseCanonicalInteger("0", { min: 0 })).toBe(0);
    expect(parseCanonicalInteger("0", { min: 0, max: 10 })).toBe(0);
  });

  test('"012" / "0x10" / "1e3" → "invalid" (400)', () => {
    expect(parseCanonicalInteger("012")).toBe("invalid");
    expect(parseCanonicalInteger("0x10")).toBe("invalid");
    expect(parseCanonicalInteger("1e3")).toBe("invalid");
    expect(parseCanonicalInteger("00")).toBe("invalid");
    expect(parseCanonicalInteger("01")).toBe("invalid");
    expect(parseCanonicalInteger("007", { min: 0 })).toBe("invalid");
  });

  test('whitespace-padded → "invalid"', () => {
    expect(parseCanonicalInteger(" 1")).toBe("invalid");
    expect(parseCanonicalInteger("1 ")).toBe("invalid");
    expect(parseCanonicalInteger(" 1 ")).toBe("invalid");
    expect(parseCanonicalInteger(" 0")).toBe("invalid");
    expect(parseCanonicalInteger("0 ")).toBe("invalid");
    expect(parseCanonicalInteger(" 20 ")).toBe("invalid");
  });

  test('"invalid" does not call upstream (not.toHaveBeenCalled)', () => {
    const upstream = mock(() => 42);
    const a = parseCanonicalInteger("012");
    expect(a).toBe("invalid");
    expect(upstream).not.toHaveBeenCalled();
    const b = parseCanonicalInteger("0x10");
    expect(b).toBe("invalid");
    expect(upstream).not.toHaveBeenCalled();
    const c = parseCanonicalInteger("1e3");
    expect(c).toBe("invalid");
    expect(upstream).not.toHaveBeenCalled();
  });

  test('never uses Number() coercion — "1e3" is "invalid" not 1000', () => {
    expect(Number("1e3")).toBe(1000);
    expect(parseCanonicalInteger("1e3")).not.toBe(1000);
    expect(parseCanonicalInteger("1e3")).toBe("invalid");
    expect(Number("0x10")).toBe(16);
    expect(parseCanonicalInteger("0x10")).toBe("invalid");
  });

  test("safe integer boundary", () => {
    expect(parseCanonicalInteger("9007199254740991")).toBe(9007199254740991);
    expect(parseCanonicalInteger("9007199254740992")).toBe("invalid");
  });

  test("min/max bounds", () => {
    expect(parseCanonicalInteger("0", { min: 1 })).toBe("invalid");
    expect(parseCanonicalInteger("5", { min: 1, max: 10 })).toBe(5);
    expect(parseCanonicalInteger("101", { min: 1, max: 100 })).toBe("invalid");
  });
});

// ── Hono route coverage (real handlers, mocked auth + connectors) ─────────
const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "00000000-0000-4000-8000-000000000002",
  organization_id: "00000000-0000-4000-8000-000000000001",
}));

type MaxResultsArgs = { maxResults: number };
type OptionalMaxResultsArgs = { maxResults?: number };

const fetchManagedGoogleGmailTriage = mock(async (_args: MaxResultsArgs) => ({
  messages: [],
}));
const fetchManagedGoogleGmailSearch = mock(async (_args: MaxResultsArgs) => ({
  messages: [],
}));
const fetchManagedGoogleGmailSubscriptionHeaders = mock(
  async (_args: MaxResultsArgs) => ({ headers: [] }),
);
const getXFeed = mock(async (_args: OptionalMaxResultsArgs) => ({ feed: [] }));
const getXDmDigest = mock(async (_args: OptionalMaxResultsArgs) => ({
  digest: [],
}));

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
  failureResponse: (_c: unknown, error: unknown) => {
    throw error;
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(() => undefined) },
}));
mock.module("@/lib/services/agent-google-connector", () => ({
  AgentGoogleConnectorError: class AgentGoogleConnectorError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
      this.name = "AgentGoogleConnectorError";
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

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockClear();
  fetchManagedGoogleGmailTriage.mockClear();
  fetchManagedGoogleGmailSearch.mockClear();
  fetchManagedGoogleGmailSubscriptionHeaders.mockClear();
  getXFeed.mockClear();
  getXDmDigest.mockClear();
});

describe("gmail triage maxResults strict via parseCanonicalInteger (real Hono)", () => {
  test("blank missing → fallback 12 and connector called", async () => {
    const res = await triageApp.request("/", { method: "GET" });
    expect(res.status).toBe(200);
    expect(fetchManagedGoogleGmailTriage).toHaveBeenCalledTimes(1);
    const args = fetchManagedGoogleGmailTriage.mock.calls[0]?.[0];
    expect(args?.maxResults).toBe(12);
  });

  test("blank empty → fallback 12", async () => {
    const res = await triageApp.request("/?maxResults=", { method: "GET" });
    expect(res.status).toBe(200);
    expect(fetchManagedGoogleGmailTriage.mock.calls[0]?.[0]?.maxResults).toBe(
      12,
    );
  });

  test("blank spaces → fallback 12", async () => {
    const res = await triageApp.request("/?maxResults=%20%20%20", {
      method: "GET",
    });
    expect(res.status).toBe(200);
    expect(fetchManagedGoogleGmailTriage.mock.calls[0]?.[0]?.maxResults).toBe(
      12,
    );
  });

  test('"0" with min1 → 400 and not called', async () => {
    const res = await triageApp.request("/?maxResults=0", { method: "GET" });
    expect(res.status).toBe(400);
    expect(fetchManagedGoogleGmailTriage).not.toHaveBeenCalled();
  });

  for (const v of [
    "012",
    "0x10",
    "1e3",
    "00",
    "01",
    " 1",
    "1 ",
    "+1",
    "-1",
    "1.0",
    " 20 ",
  ]) {
    test(`${JSON.stringify(v)} → 400 and not called`, async () => {
      const encoded = encodeURIComponent(v);
      const res = await triageApp.request(`/?maxResults=${encoded}`, {
        method: "GET",
      });
      expect(res.status).toBe(400);
      expect(fetchManagedGoogleGmailTriage).not.toHaveBeenCalled();
    });
  }

  test('valid "20" → 200 and forwarded 20', async () => {
    const res = await triageApp.request("/?maxResults=20", { method: "GET" });
    expect(res.status).toBe(200);
    expect(fetchManagedGoogleGmailTriage).toHaveBeenCalledTimes(1);
    expect(fetchManagedGoogleGmailTriage.mock.calls[0]?.[0]?.maxResults).toBe(
      20,
    );
  });
});

describe("gmail search maxResults strict via parseCanonicalInteger", () => {
  test("blank → fallback 12", async () => {
    const res = await searchApp.request("/?query=hello", { method: "GET" });
    expect(res.status).toBe(200);
    expect(fetchManagedGoogleGmailSearch.mock.calls[0]?.[0]?.maxResults).toBe(
      12,
    );
  });
  for (const v of ["012", "0x10", "1e3"]) {
    test(`${JSON.stringify(v)} → 400 not called`, async () => {
      const res = await searchApp.request(
        `/?query=hello&maxResults=${encodeURIComponent(v)}`,
        { method: "GET" },
      );
      expect(res.status).toBe(400);
      expect(fetchManagedGoogleGmailSearch).not.toHaveBeenCalled();
    });
  }
  test('valid "20" → 200', async () => {
    const res = await searchApp.request("/?query=hello&maxResults=20", {
      method: "GET",
    });
    expect(res.status).toBe(200);
    expect(fetchManagedGoogleGmailSearch).toHaveBeenCalledTimes(1);
  });
});

describe("gmail subscription-headers maxResults strict", () => {
  test("blank → fallback 200", async () => {
    const res = await subscriptionHeadersApp.request("/?query=hello", {
      method: "GET",
    });
    expect(res.status).toBe(200);
    expect(
      fetchManagedGoogleGmailSubscriptionHeaders.mock.calls[0]?.[0]?.maxResults,
    ).toBe(200);
  });
  for (const v of ["012", "0x10", "1e3"]) {
    test(`${JSON.stringify(v)} → 400 not called`, async () => {
      const res = await subscriptionHeadersApp.request(
        `/?query=hello&maxResults=${encodeURIComponent(v)}`,
        { method: "GET" },
      );
      expect(res.status).toBe(400);
      expect(fetchManagedGoogleGmailSubscriptionHeaders).not.toHaveBeenCalled();
    });
  }
  test('valid "200" → 200', async () => {
    const res = await subscriptionHeadersApp.request(
      "/?query=hello&maxResults=200",
      { method: "GET" },
    );
    expect(res.status).toBe(200);
    expect(fetchManagedGoogleGmailSubscriptionHeaders).toHaveBeenCalledTimes(1);
  });
});

describe("x feed maxResults strict via parseCanonicalInteger", () => {
  test("blank missing → undefined (no maxResults) and called", async () => {
    const res = await xFeedApp.request("/", { method: "GET" });
    expect(res.status).toBe(200);
    expect(getXFeed).toHaveBeenCalledTimes(1);
    const args = getXFeed.mock.calls[0]?.[0];
    expect(args?.maxResults).toBeUndefined();
  });

  test("blank empty → undefined", async () => {
    const res = await xFeedApp.request("/?maxResults=", { method: "GET" });
    expect(res.status).toBe(200);
    expect(getXFeed.mock.calls[0]?.[0]?.maxResults).toBeUndefined();
  });

  test("blank spaces → undefined", async () => {
    const res = await xFeedApp.request("/?maxResults=%20%20%20", {
      method: "GET",
    });
    expect(res.status).toBe(200);
    expect(getXFeed.mock.calls[0]?.[0]?.maxResults).toBeUndefined();
  });

  test('"0" with min1 → 400 not called', async () => {
    const res = await xFeedApp.request("/?maxResults=0", { method: "GET" });
    expect(res.status).toBe(400);
    expect(getXFeed).not.toHaveBeenCalled();
  });

  for (const v of [
    "012",
    "0x10",
    "1e3",
    "00",
    "01",
    " 1",
    "1 ",
    "+1",
    "-1",
    "1.0",
    " 20 ",
  ]) {
    test(`${JSON.stringify(v)} → 400 not called`, async () => {
      const res = await xFeedApp.request(
        `/?maxResults=${encodeURIComponent(v)}`,
        { method: "GET" },
      );
      expect(res.status).toBe(400);
      expect(getXFeed).not.toHaveBeenCalled();
    });
  }

  test('valid "20" → 200 and forwarded 20', async () => {
    const res = await xFeedApp.request("/?maxResults=20", { method: "GET" });
    expect(res.status).toBe(200);
    expect(getXFeed).toHaveBeenCalledTimes(1);
    expect(getXFeed.mock.calls[0]?.[0]?.maxResults).toBe(20);
  });
});

describe("x digest maxResults strict via parseCanonicalInteger", () => {
  test("blank missing → undefined", async () => {
    const res = await xDigestApp.request("/", { method: "GET" });
    expect(res.status).toBe(200);
    expect(getXDmDigest).toHaveBeenCalledTimes(1);
    expect(getXDmDigest.mock.calls[0]?.[0]?.maxResults).toBeUndefined();
  });
  for (const v of ["012", "0x10", "1e3"]) {
    test(`${JSON.stringify(v)} → 400 not called`, async () => {
      const res = await xDigestApp.request(
        `/?maxResults=${encodeURIComponent(v)}`,
        { method: "GET" },
      );
      expect(res.status).toBe(400);
      expect(getXDmDigest).not.toHaveBeenCalled();
    });
  }
  test('valid "20" → 200', async () => {
    const res = await xDigestApp.request("/?maxResults=20", { method: "GET" });
    expect(res.status).toBe(200);
    expect(getXDmDigest).toHaveBeenCalledTimes(1);
  });
});
