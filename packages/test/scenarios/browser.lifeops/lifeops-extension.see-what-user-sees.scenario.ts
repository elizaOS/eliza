import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";
import { seedBrowserCurrentPageContext } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "lifeops-extension.see-what-user-sees",
  title: "Agent reads current page context from extension",
  domain: "browser.lifeops",
  tags: ["browser", "context", "happy-path"],
  description:
    "User is on a web page and asks the agent to read the current browser page. The agent must route through MANAGE_LIFEOPS_BROWSER, read the synced page context, and surface URL, title, and selection text.",

  status: "pending",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
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
      kind: "message",
      name: "see-page-query",
      room: "main",
      text: "Read my current browser page from the LifeOps browser extension.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MANAGE_LIFEOPS_BROWSER"],
        description: "current browser page read",
        includesAll: ["read_current_page"],
      }),
      responseIncludesAny: [
        /speaker portal/i,
        /current page/i,
        /selection/i,
        /browser/i,
      ],
    },
  ],

  finalChecks: [
    {
      type: "selectedAction",
      actionName: "MANAGE_LIFEOPS_BROWSER",
    },
    {
      type: "selectedActionArguments",
      actionName: "MANAGE_LIFEOPS_BROWSER",
      includesAll: ["read_current_page"],
    },
    {
      type: "custom",
      name: "browser-current-page-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MANAGE_LIFEOPS_BROWSER"],
        description: "current browser page read",
        includesAll: ["read_current_page"],
      }),
    },
    {
      type: "custom",
      name: "browser-current-page-result",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find(
          (action) => action.actionName === "MANAGE_LIFEOPS_BROWSER",
        );
        if (!hit) {
          return "expected MANAGE_LIFEOPS_BROWSER action result";
        }
        if (
          !hit.parameters ||
          typeof hit.parameters !== "object" ||
          (hit.parameters as Record<string, unknown>).command !==
            "read_current_page"
        ) {
          return "expected MANAGE_LIFEOPS_BROWSER command read_current_page";
        }
        const data =
          hit.result?.data && typeof hit.result.data === "object"
            ? (hit.result.data as Record<string, unknown>)
            : null;
        const page =
          data?.page && typeof data.page === "object"
            ? (data.page as Record<string, unknown>)
            : null;
        if (!page) {
          return "expected page payload in MANAGE_LIFEOPS_BROWSER result";
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
