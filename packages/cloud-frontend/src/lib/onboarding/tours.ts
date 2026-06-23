import type { OnboardingTour } from "./types";

const TOURS: readonly OnboardingTour[] = [
  {
    id: "apps",
    minWidth: 768,
    steps: [
      {
        target: 'a[href="/dashboard/apps"]',
        title: "Apps",
        description:
          "Publish and manage AI-powered apps on Eliza Cloud. Apps can be shared with users, monetized via inference markups, and deployed with a single click.",
        placement: "right",
      },
      {
        target: 'a[href="/dashboard/apps/create"]',
        title: "Create an App",
        description:
          "Register a new app to get a client ID, configure purchase-share settings, and set up your hosted API endpoints.",
        placement: "right",
      },
    ],
  },
  {
    id: "agents",
    minWidth: 768,
    steps: [
      {
        target: 'a[href="/dashboard/agents"]',
        title: "Agents",
        description:
          "Agents are always-on AI instances running in the cloud. Each agent has its own memory, personality, and connected plugins.",
        placement: "right",
      },
      {
        target: 'a[href="/dashboard/my-agents"]',
        title: "My Agent",
        description:
          "Your personal agent — the one that powers the chat you use every day. Configure its model, voice, and capabilities here.",
        placement: "right",
      },
    ],
  },
  {
    id: "api-keys",
    minWidth: 768,
    steps: [
      {
        target: 'a[href="/dashboard/api-keys"]',
        title: "API Keys",
        description:
          "Generate API keys to call Eliza Cloud APIs from your own code. Keys grant full access to your organization.",
        placement: "right",
      },
    ],
  },
  {
    id: "mcps",
    minWidth: 768,
    steps: [
      {
        target: 'a[href="/dashboard/mcps"]',
        title: "MCPs",
        description:
          "Model Context Protocol servers let your agent call external tools and data sources. Browse the registry or register your own MCP here.",
        placement: "right",
      },
    ],
  },
  {
    id: "billing",
    minWidth: 768,
    steps: [
      {
        target: 'a[href="/dashboard/billing"]',
        title: "Billing",
        description:
          "Manage your subscription, view usage, and add credits. Cloud inference is billed per token — you only pay for what you use.",
        placement: "right",
      },
    ],
  },
];

const TOUR_BY_ID = new Map(TOURS.map((t) => [t.id, t]));

const PATH_TO_TOUR_ID: readonly [string, string][] = [
  ["/dashboard/apps", "apps"],
  ["/dashboard/agents", "agents"],
  ["/dashboard/my-agents", "agents"],
  ["/dashboard/api-keys", "api-keys"],
  ["/dashboard/mcps", "mcps"],
  ["/dashboard/billing", "billing"],
];

export function getTourById(id: string): OnboardingTour | undefined {
  return TOUR_BY_ID.get(id);
}

export function getTourForPath(pathname: string): OnboardingTour | undefined {
  for (const [prefix, tourId] of PATH_TO_TOUR_ID) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return TOUR_BY_ID.get(tourId);
    }
  }
  return undefined;
}
