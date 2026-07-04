/**
 * Error-path tests for the Cloud features proxy (`fetchCloudFeatures`).
 *
 * Guards the #12182 fast-fail conversion: a 200 response whose body is not
 * valid JSON is an upstream contract violation and must surface as an error, not
 * fabricate a "synced, zero features" success. Uses a stubbed `globalThis.fetch`
 * (no live Cloud) — the parse boundary under test is deterministic.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  type CloudFeaturesRouteState,
  fetchCloudFeatures,
} from "./cloud-features-routes.js";

const BASE_STATE: CloudFeaturesRouteState = {
  config: {
    cloud: { apiKey: "test-cloud-key", baseUrl: "https://cloud.example.com" },
  },
  runtime: null,
};

let originalFetch: typeof globalThis.fetch;
let originalElizaDev: string | undefined;

function stubFetch(
  response: Partial<Response> & { json?: () => Promise<unknown> },
) {
  const mock = vi.fn(async () => response as unknown as Response);
  globalThis.fetch = mock as unknown as typeof globalThis.fetch;
  return mock;
}

beforeAll(() => {
  originalFetch = globalThis.fetch;
  // Bypass validateCloudBaseUrl's DNS resolution for the public test host.
  originalElizaDev = process.env.ELIZA_DEV;
  process.env.ELIZA_DEV = "1";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalElizaDev === undefined) delete process.env.ELIZA_DEV;
  else process.env.ELIZA_DEV = originalElizaDev;
});

describe("fetchCloudFeatures", () => {
  it("surfaces an unparseable 200 body as an error instead of zero features", async () => {
    stubFetch({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON at position 0");
      },
    });

    const result = await fetchCloudFeatures(BASE_STATE);

    expect(result.status).toBe(502);
    expect(result.error).toMatch(/not valid JSON/i);
    expect(result.rows).toHaveLength(0);
  });

  it("returns parsed rows with no error when the 200 body is valid JSON", async () => {
    stubFetch({
      ok: true,
      status: 200,
      json: async () => ({
        features: [{ featureKey: "not_a_real_feature", enabled: true }],
      }),
    });

    const result = await fetchCloudFeatures(BASE_STATE);

    expect(result.status).toBe(200);
    expect(result.error).toBeNull();
    // Unknown feature keys are dropped by parseCloudFeatures; the point is that
    // a well-formed body is NOT treated as an error (no over-removal).
    expect(Array.isArray(result.rows)).toBe(true);
  });

  it("treats a genuinely empty but valid feature list as success, not an error", async () => {
    stubFetch({
      ok: true,
      status: 200,
      json: async () => ({ features: [] }),
    });

    const result = await fetchCloudFeatures(BASE_STATE);

    expect(result.status).toBe(200);
    expect(result.error).toBeNull();
    expect(result.rows).toHaveLength(0);
  });
});
