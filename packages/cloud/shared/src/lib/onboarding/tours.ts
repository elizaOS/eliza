/**
 * Tour definitions for onboarding overlays.
 */

import type { OnboardingTour } from "./types";

export const APPS_TOUR: OnboardingTour = {
  id: "apps",
  pathPattern: "/dashboard/apps",
  steps: [
    {
      target: "[data-onboarding='apps-stats']",
      title: "Apps Overview",
      description:
        "Track your apps' performance at a glance. See total apps, active apps, users, and API requests.",
      placement: "bottom",
    },
    {
      target: "[data-onboarding='apps-table']",
      title: "Your Apps",
      description:
        "All your apps are listed here. Click on any app to view details, manage settings, and see analytics.",
      placement: "top",
    },
    {
      target: "[data-onboarding='apps-ai-builder']",
      title: "AI App Builder",
      description:
        "Use our AI assistant to help you build and configure an app automatically with natural language.",
      placement: "bottom",
    },
    {
      target: "[data-onboarding='apps-create']",
      title: "Create Your First App",
      description:
        "Ready to get started? Click here to create an app that integrates with your Eliza Cloud agents via API.",
      placement: "bottom",
    },
  ],
};

export const AGENTS_TOUR: OnboardingTour = {
  id: "agents",
  pathPattern: "/dashboard/agents",
  steps: [
    {
      target: "[data-onboarding='agents-header']",
      title: "Your Eliza Agents",
      description:
        "This is your agent roster. Each agent is a persistent AI instance you can chat with, connect to apps, and customize.",
      placement: "bottom",
    },
    {
      target: "[data-onboarding='agents-table']",
      title: "Agent List",
      description:
        "See all your agents here — their status, tier, and quick-access links. Click any row to manage that agent.",
      placement: "top",
    },
    {
      target: "[data-onboarding='agents-create']",
      title: "Create an Agent",
      description:
        "Spin up a new Eliza agent in seconds. Choose shared (instant) or dedicated (always-on) hosting.",
      placement: "bottom",
    },
  ],
};

export const BILLING_TOUR: OnboardingTour = {
  id: "billing",
  pathPattern: "/dashboard/billing",
  steps: [
    {
      target: "[data-onboarding='billing-balance']",
      title: "Your Credit Balance",
      description:
        "Credits power all inference and hosting on Eliza Cloud. Your current balance is shown here.",
      placement: "bottom",
    },
    {
      target: "[data-onboarding='billing-add-credits']",
      title: "Add Credits",
      description:
        "Top up your balance at any time. Credits never expire and are shared across all your agents and apps.",
      placement: "bottom",
    },
    {
      target: "[data-onboarding='billing-usage']",
      title: "Usage Breakdown",
      description:
        "See exactly where your credits are going — by agent, app, model, and connector.",
      placement: "top",
    },
  ],
};

export const API_KEYS_TOUR: OnboardingTour = {
  id: "api-keys",
  pathPattern: "/dashboard/api-keys",
  steps: [
    {
      target: "[data-onboarding='api-keys-header']",
      title: "API Keys",
      description:
        "API keys let your code talk directly to your Eliza agents. Use them in scripts, apps, or integrations.",
      placement: "bottom",
    },
    {
      target: "[data-onboarding='api-keys-create']",
      title: "Create a Key",
      description:
        "Generate a new API key with a descriptive name so you remember what it's for. You can revoke it any time.",
      placement: "bottom",
    },
    {
      target: "[data-onboarding='api-keys-table']",
      title: "Manage Keys",
      description:
        "All your active keys are listed here with creation date and last-used time. Revoke any key instantly.",
      placement: "top",
    },
  ],
};

export const MCPS_TOUR: OnboardingTour = {
  id: "mcps",
  pathPattern: "/dashboard/mcps",
  steps: [
    {
      target: "[data-onboarding='mcps-header']",
      title: "MCP Connections",
      description:
        "Model Context Protocol servers extend your agent with tools — calendars, databases, APIs, and more.",
      placement: "bottom",
    },
    {
      target: "[data-onboarding='mcps-list']",
      title: "Connected MCPs",
      description:
        "Your active MCP servers are listed here. Each one adds new capabilities your agent can use in conversation.",
      placement: "top",
    },
    {
      target: "[data-onboarding='mcps-add']",
      title: "Add an MCP Server",
      description:
        "Connect any MCP-compatible server by URL. Your agent will automatically discover its tools on the next restart.",
      placement: "bottom",
    },
  ],
};

export const ALL_TOURS: OnboardingTour[] = [
  APPS_TOUR,
  AGENTS_TOUR,
  BILLING_TOUR,
  API_KEYS_TOUR,
  MCPS_TOUR,
];

export function getTourById(id: string): OnboardingTour | undefined {
  return ALL_TOURS.find((tour) => tour.id === id);
}

export function getTourForPath(path: string): OnboardingTour | undefined {
  return ALL_TOURS.find((tour) => path.startsWith(tour.pathPattern));
}
