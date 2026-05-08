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

export const ALL_TOURS: OnboardingTour[] = [APPS_TOUR];

export function getTourById(id: string): OnboardingTour | undefined {
  return ALL_TOURS.find((tour) => tour.id === id);
}

export function getTourForPath(path: string): OnboardingTour | undefined {
  return ALL_TOURS.find((tour) => path.startsWith(tour.pathPattern));
}
