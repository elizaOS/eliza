/**
 * Executes GitHub popup response scripts against a recorded opener.
 * Host callback and iframe guards cover their separate target-origin policies.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { capturePopupMessages } from "../../../test-support/popup-response";

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
  test.each([
    [true, "https://app.eliza.how", "open", true],
    [true, null, "open", false],
    [false, "https://app.eliza.how", "open", false],
    [true, "https://app.eliza.how", "closed", false],
    [true, "https://app.eliza.how", "absent", false],
  ] as const)(
    "delivers only to an enabled, configured, open opener (%p, %p, %p)",
    async (postMessage, targetOrigin, opener, delivers) => {
      const response = createLifeOpsGithubReturnResponse({
        title: "Connected",
        message: "Return to your agent",
        detail: { target: "agent", status: "connected", agentId: "a1" },
        postMessage,
        targetOrigin,
      });
      expect(response.status).toBe(200);
      const messages = capturePopupMessages(await response.text(), opener);
      expect(messages).toEqual(
        delivers
          ? [
              {
                targetOrigin,
                payload: expect.objectContaining({
                  type: "agent-lifeops-github-complete",
                  target: "agent",
                  status: "connected",
                  agentId: "a1",
                }),
              },
            ]
          : [],
      );
    },
  );

  test("agent-hosted callback retains its same-origin target", () => {
    const repoRoot = path.resolve(import.meta.dir, "../../../../../..");
    // LifeOps agent-hosted callback is same-origin, window.location.origin is intentional and documented.
    const lifeOpsSrc = readFileSync(
      path.join(repoRoot, "plugins/plugin-personal-assistant/src/routes/lifeops-routes.ts"),
      "utf8",
    );
    expect(lifeOpsSrc).toContain("window.location.origin");
    expect(lifeOpsSrc).not.toContain('postMessage(payload, "*"');
    expect(lifeOpsSrc).toContain("same-origin");
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
