/** Proves BROWSER reads the complete synchronized companion page context. */

import { scenario } from "@elizaos/scenario-runner/schema";
import { seedBrowserCurrentPageContext } from "../../../scenario-support/lifeops-seeds.ts";

export default scenario({
  lane: "pr-deterministic",
  id: "lifeops-extension.see-what-user-sees",
  title: "Agent reads current page context from extension",
  domain: "browser.lifeops",
  evidenceScope: "domain-contract",
  executionProfile: "simulated",
  tags: ["browser", "context", "companion", "durable-readback"],
  description:
    "Seeds the browser-companion projection, invokes BROWSER.state against the bridge target, and verifies the complete typed page receipt.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-browser"],
  },

  seed: [
    {
      type: "custom",
      name: "seed-current-browser-page-context",
      apply: seedBrowserCurrentPageContext({
        browser: "chrome",
        profileId: "profile-1",
        windowId: "window-1",
        tabId: "tab-1",
        url: "https://speaker-portal.example.com/submissions",
        title: "Speaker Portal Submissions",
        selectionText: "selected deck details",
        mainText: "Speaker portal submissions and review queue",
        headings: ["Submissions", "Review queue"],
        links: [
          {
            text: "Back to dashboard",
            href: "https://speaker-portal.example.com/dashboard",
          },
        ],
        forms: [
          {
            action: "https://speaker-portal.example.com/submissions",
            fields: ["deckUrl", "speakerName"],
          },
        ],
      }),
    },
  ],

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Browser extension: see what user sees",
    },
  ],

  turns: [
    {
      kind: "action",
      name: "see-page-query",
      room: "main",
      actionName: "BROWSER",
      text: "Read the synchronized current companion page.",
      options: { parameters: { action: "state", target: "bridge" } },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: "BROWSER",
      status: "success",
    },
    {
      type: "custom",
      name: "browser-current-page-result",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find(
          (action) => action.actionName === "BROWSER",
        );
        if (!hit) {
          return "expected BROWSER action result";
        }
        const data =
          hit.result?.data && typeof hit.result.data === "object"
            ? (hit.result.data as Record<string, unknown>)
            : null;
        const result =
          data?.result && typeof data.result === "object"
            ? (data.result as Record<string, unknown>)
            : null;
        const page =
          result?.value && typeof result.value === "object"
            ? (result.value as Record<string, unknown>)
            : null;
        if (!page) {
          return "expected page payload in BROWSER state result";
        }
        if (page.url !== "https://speaker-portal.example.com/submissions") {
          return `expected seeded page url in result payload, got ${String(page.url ?? "")}`;
        }
        if (page.title !== "Speaker Portal Submissions") {
          return `expected seeded page title in result payload, got ${String(page.title ?? "")}`;
        }
        if (page.selectionText !== "selected deck details") {
          return `expected seeded page selectionText in result payload, got ${String(page.selectionText ?? "")}`;
        }
        if (page.mainText !== "Speaker portal submissions and review queue") {
          return `expected seeded page mainText in result payload, got ${String(page.mainText ?? "")}`;
        }
        const links = Array.isArray(page.links) ? page.links : [];
        if (
          !links.some((link) => {
            if (!link || typeof link !== "object") {
              return false;
            }
            const candidate = link as Record<string, unknown>;
            return (
              candidate.text === "Back to dashboard" &&
              candidate.href === "https://speaker-portal.example.com/dashboard"
            );
          })
        ) {
          return "expected seeded page links in result payload";
        }
        const forms = Array.isArray(page.forms) ? page.forms : [];
        if (
          !forms.some((form) => {
            if (!form || typeof form !== "object") {
              return false;
            }
            const candidate = form as Record<string, unknown>;
            const fields = Array.isArray(candidate.fields)
              ? candidate.fields
              : [];
            return (
              candidate.action ===
                "https://speaker-portal.example.com/submissions" &&
              fields.includes("deckUrl") &&
              fields.includes("speakerName")
            );
          })
        ) {
          return "expected seeded page forms in result payload";
        }
        return undefined;
      },
    },
  ],
});
