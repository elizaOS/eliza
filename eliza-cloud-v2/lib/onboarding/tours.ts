/**
 * Tour definitions for onboarding overlays.
 */

import type { OnboardingTour } from "./types";

export const BUILD_TOUR: OnboardingTour = {
  id: "build",
  pathPattern: "/dashboard/build",
  minWidth: 1024, // Only show on desktop (lg breakpoint) where split pane is visible
  steps: [
    {
      target: "[data-onboarding='build-assistant']",
      title: "AI Assistant",
      description:
        "Chat with the AI to describe your agent's personality, capabilities, and behavior. The assistant will help you configure your agent.",
      placement: "right",
    },
    {
      target: "[data-onboarding='build-editor']",
      title: "Character Editor",
      description:
        "View and fine-tune your agent's configuration in real-time. Changes you make here are reflected immediately.",
      placement: "left",
    },
    {
      target: "[data-onboarding='build-save']",
      title: "Save Your Agent",
      description:
        "Once you're happy with your agent, click here to save it and start chatting!",
      placement: "bottom",
    },
  ],
};

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

export const ALL_TOURS: OnboardingTour[] = [BUILD_TOUR, APPS_TOUR];

export function getTourById(id: string): OnboardingTour | undefined {
  return ALL_TOURS.find((tour) => tour.id === id);
}

export function getTourForPath(path: string): OnboardingTour | undefined {
  return ALL_TOURS.find((tour) => path.startsWith(tour.pathPattern));
}
