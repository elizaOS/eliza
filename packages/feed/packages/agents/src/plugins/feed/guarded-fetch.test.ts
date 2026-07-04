import { describe, expect, test } from "bun:test";
import { createGuardedFetchImpl, guardedFetch } from "./guarded-fetch";

/**
 * Proves #12229 L9: the Feed A2A agent-card fetch routes through the core SSRF
 * guard, so an operator/agent-supplied card URL cannot reach a private/
 * link-local target. Runs the real guard against literal internal IPs (no DNS,
 * no egress); asserts the request is refused rather than silently fetched.
 */
describe("Feed A2A guardedFetch SSRF guard (#12229 L9)", () => {
  const privateCardUrls = [
    "http://169.254.169.254/.well-known/agent-card.json",
    "http://10.0.0.5/.well-known/agent-card.json",
    "http://127.0.0.1:3000/.well-known/agent-card.json",
    "http://[::1]/.well-known/agent-card.json",
  ];

  for (const url of privateCardUrls) {
    test(`guardedFetch blocks the private card URL ${url}`, async () => {
      await expect(guardedFetch(url)).rejects.toThrow(
        /private|internal|Blocked/i,
      );
    });
  }

  test("createGuardedFetchImpl also blocks a private card URL and injects headers", async () => {
    let injected: string | null = null;
    const impl = createGuardedFetchImpl((headers) => {
      headers.set("x-feed-api-key", "k");
      injected = headers.get("x-feed-api-key");
    });
    await expect(
      impl("http://169.254.169.254/tasks"),
    ).rejects.toThrow(/private|internal|Blocked/i);
    // Header injection runs before the guard refuses the connect.
    expect(injected).toBe("k");
  });

  test("blocks a blocked internal hostname", async () => {
    await expect(
      guardedFetch("http://metadata.google.internal/agent-card.json"),
    ).rejects.toThrow(/Blocked|internal/i);
  });
});
