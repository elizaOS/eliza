/**
 * Covers the opener postMessage targetOrigin pinning for LifeOps GitHub return.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  createLifeOpsGithubReturnResponse,
  normalizePostMessageTargetOrigin,
} from "./agent-github-return";

describe("createLifeOpsGithubReturnResponse — targetOrigin pinning", () => {
  test.each([
    ["https://app.eliza.how/path?query=1", "https://app.eliza.how"],
    ["http://127.0.0.1:5173/callback", "http://127.0.0.1:5173"],
    ["*", null],
    ["data:text/html,opaque", null],
    ["javascript:alert(1)", null],
    ["not a URL", null],
    ["", null],
  ])("normalizes configured opener origin %p", (value, expected) => {
    expect(normalizePostMessageTargetOrigin(value)).toBe(expected);
  });
  test("uses configured targetOrigin, not wildcard", async () => {
    const res = createLifeOpsGithubReturnResponse({
      title: "ok",
      message: "done",
      detail: { target: "agent", status: "connected", agentId: "a1" },
      postMessage: true,
      returnUrl: null,
      targetOrigin: "https://app.eliza.how",
    });
    const html = await res.text();
    expect(html).toContain("https://app.eliza.how");
    expect(html).toContain("targetOrigin");
    expect(html).not.toContain('postMessage(payload, "*"');
    expect(html).not.toContain("postMessage(payload, '*'");
  });

  test("fail-closed when targetOrigin absent — no postMessage with wildcard or window.location.origin", async () => {
    const res = createLifeOpsGithubReturnResponse({
      title: "ok",
      message: "done",
      detail: { target: "agent", status: "connected", agentId: "a1" },
      postMessage: true,
      returnUrl: null,
      targetOrigin: null,
    });
    const html = await res.text();
    expect(html).not.toContain('postMessage(payload, "*"');
    // When no targetOrigin, the postMessage branch is guarded by `targetOrigin &&`
    expect(html).toContain("targetOrigin &&");
  });

  test("does not emit wildcard when postMessage disabled", async () => {
    const res = createLifeOpsGithubReturnResponse({
      title: "ok",
      message: "done",
      detail: { target: "owner", status: "error", message: "nope" },
      postMessage: false,
      returnUrl: null,
    });
    const html = await res.text();
    expect(html).not.toContain('postMessage(payload, "*"');
  });

  test("opener postMessage routes are pinned — no wildcard, no window.location.origin fallback for PayPal", () => {
    const repoRoot = path.resolve(import.meta.dir, "../../../../../..");
    const checks: Array<{ rel: string; mustContain: string; mustNotContain: string[] }> = [
      {
        rel: "packages/cloud/api/v1/eliza/paypal/popup-callback/route.ts",
        mustContain: "targetOrigin && window.opener",
        mustNotContain: [
          'postMessage(payload, "*"',
          "postMessage(payload, window.location.origin)",
        ],
      },
      {
        rel: "packages/cloud/api/eliza-app/auth/connection-success/route.ts",
        mustContain: "targetOrigin && window.opener",
        mustNotContain: [
          'postMessage(payload, "*"',
          "postMessage(payload, window.location.origin)",
        ],
      },
      {
        rel: "packages/cloud/shared/src/lib/services/agent-github-return.ts",
        mustContain: "targetOrigin && window.opener",
        mustNotContain: [
          'postMessage(payload, "*"',
          "postMessage(payload, window.location.origin)",
        ],
      },
    ];
    for (const { rel, mustContain, mustNotContain } of checks) {
      const src = readFileSync(path.join(repoRoot, rel), "utf8");
      const openerCalls = [...src.matchAll(/window\.opener\.postMessage\([^)]+\)/g)].map(
        (m) => m[0],
      );
      expect(openerCalls.length).toBeGreaterThan(0);
      for (const call of openerCalls) {
        expect(call).not.toContain('"*"');
        expect(call).not.toContain("'*'");
      }
      expect(src).toContain(mustContain);
      for (const banned of mustNotContain) {
        expect(src).not.toContain(banned);
      }
    }
    // LifeOps agent-hosted callback is same-origin, window.location.origin is intentional and documented.
    const lifeOpsSrc = readFileSync(
      path.join(repoRoot, "plugins/plugin-personal-assistant/src/routes/lifeops-routes.ts"),
      "utf8",
    );
    expect(lifeOpsSrc).toContain("window.location.origin");
    expect(lifeOpsSrc).not.toContain('postMessage(payload, "*"');
    expect(lifeOpsSrc).toContain("same-origin");
  });

  test("paypal route fails closed when AGENT_APP_ORIGIN absent — no window.location.origin fallback", () => {
    const src = readFileSync(
      path.resolve(import.meta.dir, "../../../../api/v1/eliza/paypal/popup-callback/route.ts"),
      "utf8",
    );
    expect(src).toContain("const targetOrigin =");
    expect(src).toContain("targetOrigin && window.opener");
    // No fallback to popup origin in the postMessage path — only comment may mention it
    expect(src).not.toContain(
      "targetOrigin = serverOrigin ? serverOrigin : window.location.origin",
    );
    expect(src).not.toContain("window.location.origin;");
    // Must deliver to configured opener origin, not popup origin
    expect(src).toContain("window.opener.postMessage(payload, targetOrigin)");
    expect(src).not.toMatch(/:\s*"\*"/);
  });

  test("SandboxedViewFrame opaque-origin wildcard is intentionally retained", () => {
    const src = readFileSync(
      path.resolve(
        import.meta.dir,
        "../../../../../..",
        "packages/ui/src/components/views/SandboxedViewFrame.tsx",
      ),
      "utf8",
    );
    expect(src).toContain('frameWindow.postMessage(response, "*")');
    expect(src).toContain("Opaque-origin frames cannot be targeted by origin");
  });
});
