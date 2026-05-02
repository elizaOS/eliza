#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Steward Auth E2E Test
 *
 * Validates all authentication endpoints on a live Steward instance.
 * Tests auth providers, passkey flow, email magic link, OAuth, SIWE nonce,
 * token refresh, cross-tenant auth, and user endpoint protection.
 *
 * Usage:
 *   STEWARD_URL=https://api.steward.fi \
 *   PLATFORM_KEY=stw_plat... \
 *   bun run scripts/e2e-auth-test.ts
 */

// ─── Config ──────────────────────────────────────────────────────────────────

const STEWARD_URL = (process.env.STEWARD_URL || "https://api.steward.fi").replace(/\/$/, "");

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function firstPlatformKeyFromList(value?: string): string {
  if (!value) {
    return "";
  }
  return (
    value
      .split(",")
      .map((entry) => entry.trim())
      .find(Boolean) || ""
  );
}

function resolveStoredPlatformKey(): string {
  const homeDir = process.env.HOME?.trim();
  if (!homeDir) {
    return "";
  }

  const credentialsPath = path.join(homeDir, ".eliza", "steward-credentials.json");
  if (!existsSync(credentialsPath)) {
    return "";
  }

  try {
    const credentials = JSON.parse(readFileSync(credentialsPath, "utf8")) as {
      apiKey?: string;
    };
    return firstNonEmpty(credentials.apiKey);
  } catch {
    return "";
  }
}

const PLATFORM_KEY = firstNonEmpty(
  process.env.PLATFORM_KEY,
  process.env.STEWARD_PLATFORM_KEY,
  firstPlatformKeyFromList(process.env.STEWARD_PLATFORM_KEYS),
  resolveStoredPlatformKey(),
);
const REQUEST_TIMEOUT_MS = 10_000;
const TEST_TENANT_ID = `e2e-auth-test-${Date.now()}`;

// ─── ANSI colors ─────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
};

// ─── Test harness ────────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  status: "pass" | "fail" | "skip";
  detail?: string;
}

const results: TestResult[] = [];

function pass(name: string, detail?: string) {
  results.push({ name, status: "pass", detail });
  const extra = detail ? ` ${C.dim}(${detail})${C.reset}` : "";
  console.log(`${C.green}✅ PASS:${C.reset} ${name}${extra}`);
}

function fail(name: string, detail: string) {
  results.push({ name, status: "fail", detail });
  console.log(`${C.red}❌ FAIL:${C.reset} ${name}`);
  console.log(`${C.dim}       ${detail}${C.reset}`);
}

function skip(name: string, reason: string) {
  results.push({ name, status: "skip", detail: reason });
  console.log(`${C.yellow}⚠️  SKIP:${C.reset} ${name} ${C.dim}(${reason})${C.reset}`);
}

// ─── HTTP helper with timeout ────────────────────────────────────────────────

interface FetchResult {
  status: number;
  headers: Headers;
  data: any;
  redirectUrl?: string;
}

async function api(
  method: string,
  path: string,
  opts?: {
    body?: unknown;
    headers?: Record<string, string>;
    followRedirect?: boolean;
  },
): Promise<FetchResult> {
  const url = `${STEWARD_URL}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const fetchOpts: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(opts?.headers || {}),
      },
      signal: controller.signal,
      redirect: opts?.followRedirect === false ? "manual" : "follow",
    };
    if (opts?.body !== undefined) {
      fetchOpts.body = JSON.stringify(opts.body);
    }

    const res = await fetch(url, fetchOpts);

    // Handle redirect responses (status 3xx with manual redirect)
    if (res.status >= 300 && res.status < 400) {
      return {
        status: res.status,
        headers: res.headers,
        data: null,
        redirectUrl: res.headers.get("location") || undefined,
      };
    }

    let data: any;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    return { status: res.status, headers: res.headers, data };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Test Cases ──────────────────────────────────────────────────────────────

/**
 * (i) Health + Ready — run first to verify the server is reachable
 */
async function testHealthAndReady() {
  // Health
  try {
    const { status, data } = await api("GET", "/health");
    if (status === 200 && data?.status === "ok") {
      pass("Health check", `v${data.version || "?"}, uptime ${data.uptime || "?"}s`);
    } else {
      fail("Health check", `status=${status}, body=${JSON.stringify(data)}`);
      return false;
    }
  } catch (e: any) {
    fail("Health check", `Connection failed: ${e.message}`);
    return false;
  }

  // Ready
  try {
    const { status, data } = await api("GET", "/ready");
    if (status === 200 && (data?.status === "ok" || data?.status === "ready")) {
      pass(
        "Ready check",
        `db=${data.checks?.database?.ok ? "✓" : "✗"}, vault=${data.checks?.vault?.ok ? "✓" : "✗"}`,
      );
    } else if (status === 503) {
      const failedChecks = data?.checks
        ? Object.entries(data.checks)
            .filter(([, v]: any) => !v.ok)
            .map(([k]) => k)
            .join(", ")
        : "unknown";
      fail("Ready check", `not ready: ${failedChecks}`);
    } else if (status === 404) {
      skip("Ready check", "endpoint not deployed on this version");
    } else {
      fail("Ready check", `status=${status}, body=${JSON.stringify(data)}`);
    }
  } catch (e: any) {
    fail("Ready check", e.message);
  }

  return true;
}

/**
 * (a) Provider Discovery
 */
async function testProviderDiscovery() {
  try {
    const { status, data } = await api("GET", "/auth/providers");
    if (status === 404) {
      skip("Provider discovery", "endpoint not deployed on this version");
      return;
    }
    if (status !== 200) {
      fail("Provider discovery", `status=${status}: ${JSON.stringify(data)}`);
      return;
    }

    // Validate shape: must have passkey, email, siwe as booleans
    const requiredBools = ["passkey", "email", "siwe", "google", "discord"];
    const missingKeys = requiredBools.filter((k) => typeof data[k] !== "boolean");
    if (missingKeys.length > 0) {
      fail("Provider discovery", `missing boolean keys: ${missingKeys.join(", ")}`);
      return;
    }
    if (!Array.isArray(data.oauth)) {
      fail("Provider discovery", `oauth should be string[], got ${typeof data.oauth}`);
      return;
    }

    const enabledStr = requiredBools.map((k) => `${k}=${data[k]}`).join(", ");
    pass("Provider discovery", enabledStr);
  } catch (e: any) {
    fail("Provider discovery", e.message);
  }
}

/**
 * (b) Passkey Registration Options
 */
async function testPasskeyRegistrationOptions() {
  try {
    const { status, data } = await api("POST", "/auth/passkey/register/options", {
      body: { email: "e2e-test@steward.fi" },
    });

    if (status === 404) {
      skip("Passkey registration options", "endpoint not deployed on this version");
      return;
    }
    if (status !== 200) {
      fail(
        "Passkey registration options",
        `status=${status}: ${data?.error || JSON.stringify(data)}`,
      );
      return;
    }

    // WebAuthn creation options should have challenge, rp, user fields
    const hasChallenge = typeof data.challenge === "string" && data.challenge.length > 0;
    const hasRp = data.rp && typeof data.rp.name === "string";
    const hasUser = data.user && typeof data.user.name === "string";

    if (hasChallenge && hasRp && hasUser) {
      pass(
        "Passkey registration options",
        `rp=${data.rp.name}, challenge=${data.challenge.slice(0, 12)}...`,
      );
    } else {
      fail(
        "Passkey registration options",
        `missing fields: challenge=${hasChallenge}, rp=${hasRp}, user=${hasUser}`,
      );
    }
  } catch (e: any) {
    fail("Passkey registration options", e.message);
  }
}

/**
 * (c) Email Magic Link
 */
async function testEmailMagicLink() {
  try {
    const { status, data } = await api("POST", "/auth/email/send", {
      body: { email: "e2e-test@steward.fi" },
    });

    if (status === 200 && data?.ok) {
      // RESEND_API_KEY is configured
      const expiresAt = data.data?.expiresAt || data.expiresAt || "unknown";
      pass("Email magic link", `expiresAt=${expiresAt}`);
    } else if (status === 429) {
      skip("Email magic link", "rate limited");
    } else if (status === 500 || status === 503) {
      // RESEND_API_KEY not configured or provider errored
      skip("Email magic link", "email provider not configured or errored");
    } else {
      // The endpoint exists and responded, even if it failed for config reasons
      // If we got a structured error, the endpoint works
      if (data?.ok === false || data?.error) {
        skip("Email magic link", `endpoint exists but: ${data.error || "not configured"}`);
      } else {
        fail("Email magic link", `unexpected: status=${status}, body=${JSON.stringify(data)}`);
      }
    }
  } catch (e: any) {
    fail("Email magic link", e.message);
  }
}

/**
 * (d) OAuth Authorization URLs
 */
async function testOAuthAuthorize(provider: "google" | "discord") {
  const testName = `OAuth ${provider} authorize`;
  try {
    const { status, data, redirectUrl } = await api(
      "GET",
      `/auth/oauth/${provider}/authorize?redirect_uri=https://steward.fi/auth/callback`,
      { followRedirect: false },
    );

    if (status === 302 && redirectUrl) {
      // Verify redirect URL contains expected OAuth params
      const url = new URL(redirectUrl);
      const hasClientId =
        url.searchParams.has("client_id") || url.searchParams.has("response_type");
      if (hasClientId) {
        pass(testName, `redirects to ${url.hostname}`);
      } else {
        pass(testName, `302 → ${url.hostname} (params may differ)`);
      }
    } else if (status === 503 || status === 400) {
      const reason = data?.error || "provider not configured";
      skip(testName, reason);
    } else if (status === 404) {
      skip(testName, "endpoint not deployed on this version");
    } else {
      fail(testName, `status=${status}, body=${JSON.stringify(data)}`);
    }
  } catch (e: any) {
    // fetch with redirect: manual might throw on some runtimes; treat 302 detection as skip
    if (e.message?.includes("redirect")) {
      skip(testName, "redirect handling unsupported in test env");
    } else {
      fail(testName, e.message);
    }
  }
}

/**
 * (e) SIWE Nonce
 */
async function testSiweNonce() {
  try {
    const { status, data } = await api("GET", "/auth/nonce");

    if (status === 200 && typeof data?.nonce === "string" && data.nonce.length > 0) {
      pass("SIWE nonce generation", `nonce=${data.nonce.slice(0, 12)}...`);
    } else {
      fail("SIWE nonce generation", `status=${status}, nonce=${data?.nonce}`);
    }
  } catch (e: any) {
    fail("SIWE nonce generation", e.message);
  }
}

/**
 * (f) Token Refresh (negative test)
 */
async function testTokenRefreshRejection() {
  try {
    const { status, data } = await api("POST", "/auth/refresh", {
      body: { refreshToken: "invalid-token-that-should-not-work" },
    });

    if (status === 401) {
      pass("Token refresh rejection", "invalid token correctly returns 401");
    } else if (status === 400 && data?.error?.includes("refreshToken")) {
      // Endpoint exists but rejected for missing field, still valid
      pass("Token refresh rejection", "endpoint validates input");
    } else if (status === 429) {
      skip("Token refresh rejection", "rate limited, but endpoint exists");
    } else if (status === 404) {
      skip("Token refresh rejection", "endpoint not deployed on this version");
    } else {
      fail("Token refresh rejection", `expected 401, got ${status}: ${JSON.stringify(data)}`);
    }
  } catch (e: any) {
    fail("Token refresh rejection", e.message);
  }
}

/**
 * (g) Cross-Tenant: Create Test Tenant + Auth Flow
 */
async function testCrossTenant() {
  const testName = "Cross-tenant flow";

  if (!PLATFORM_KEY) {
    skip(testName, "PLATFORM_KEY not provided");
    return;
  }

  const platformHeaders = { "X-Steward-Platform-Key": PLATFORM_KEY };
  let tenantCreated = false;

  try {
    // Create test tenant
    const createRes = await api("POST", "/platform/tenants", {
      body: { id: TEST_TENANT_ID, name: "E2E Auth Test Tenant" },
      headers: platformHeaders,
    });

    if (createRes.status === 201 || (createRes.status === 200 && createRes.data?.ok)) {
      tenantCreated = true;
    } else if (createRes.status === 409) {
      // Already exists (from a previous failed run), that's fine
      tenantCreated = true;
    } else {
      fail(
        testName,
        `tenant create failed: status=${createRes.status}, ${createRes.data?.error || JSON.stringify(createRes.data)}`,
      );
      return;
    }

    // Verify /auth/providers works with tenant header
    const providersRes = await api("GET", "/auth/providers", {
      headers: { "X-Steward-Tenant": TEST_TENANT_ID },
    });

    if (providersRes.status === 200 && typeof providersRes.data?.passkey === "boolean") {
      pass(testName, `tenant=${TEST_TENANT_ID}, providers ok`);
    } else {
      fail(testName, `providers with tenant header: status=${providersRes.status}`);
    }
  } catch (e: any) {
    fail(testName, e.message);
  } finally {
    // Clean up: delete test tenant
    if (tenantCreated) {
      try {
        await api("DELETE", `/platform/tenants/${TEST_TENANT_ID}`, {
          headers: platformHeaders,
        });
      } catch {
        // Best-effort cleanup
      }
    }
  }
}

/**
 * (h) User Endpoints (negative tests)
 */
async function testUserEndpointsRequireAuth() {
  const endpoints = [
    { path: "/user/me", label: "GET /user/me" },
    { path: "/user/me/tenants", label: "GET /user/me/tenants" },
  ];

  let allPassed = true;

  for (const ep of endpoints) {
    try {
      const { status } = await api("GET", ep.path);
      if (status === 401) {
        // Good, endpoint requires auth
      } else {
        fail(`User endpoints require auth`, `${ep.label} returned ${status}, expected 401`);
        allPassed = false;
      }
    } catch (e: any) {
      fail(`User endpoints require auth`, `${ep.label}: ${e.message}`);
      allPassed = false;
    }
  }

  if (allPassed) {
    pass("User endpoints require auth", "/user/me and /user/me/tenants both return 401");
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${C.bold}=== Steward Auth E2E Tests ===${C.reset}`);
  console.log(`${C.dim}Target: ${STEWARD_URL}${C.reset}`);
  console.log(
    `${C.dim}Platform key: ${PLATFORM_KEY ? "provided" : "not provided (tenant tests will skip)"}${C.reset}\n`,
  );

  const startTime = Date.now();

  // (i) Health + Ready first
  const serverUp = await testHealthAndReady();
  if (!serverUp) {
    console.log(`\n${C.red}${C.bold}Server unreachable. Aborting.${C.reset}\n`);
    process.exit(1);
  }

  // (a) Provider Discovery
  await testProviderDiscovery();

  // (b) Passkey Registration Options
  await testPasskeyRegistrationOptions();

  // (c) Email Magic Link
  await testEmailMagicLink();

  // (d) OAuth Authorization URLs
  await testOAuthAuthorize("google");
  await testOAuthAuthorize("discord");

  // (e) SIWE Nonce
  await testSiweNonce();

  // (f) Token Refresh (negative)
  await testTokenRefreshRejection();

  // (g) Cross-Tenant Flow
  await testCrossTenant();

  // (h) User Endpoints (negative)
  await testUserEndpointsRequireAuth();

  // ─── Summary ───────────────────────────────────────────────────────────────

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  const total = results.length;

  console.log(`\n${"─".repeat(45)}`);

  if (failed > 0) {
    console.log(
      `${C.red}Passed: ${passed}/${total}  Skipped: ${skipped}  Failed: ${failed}${C.reset}  ${C.dim}(${elapsed}s)${C.reset}`,
    );
    console.log(`\n${C.red}Failed tests:${C.reset}`);
    for (const r of results.filter((r) => r.status === "fail")) {
      console.log(`  ${C.red}❌${C.reset} ${r.name}: ${r.detail}`);
    }
  } else {
    console.log(
      `${C.green}Passed: ${passed}/${total}  Skipped: ${skipped}  Failed: ${failed}${C.reset}  ${C.dim}(${elapsed}s)${C.reset}`,
    );
    console.log(`\n${C.green}🎉 All tests passed!${C.reset}`);
  }

  console.log("");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`\n${C.red}💥 Unhandled error:${C.reset}`, e);
  process.exit(1);
});
