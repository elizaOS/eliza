import type { TutorialStep } from "@/components/tutorial/SpotlightTutorial";

export type { TutorialStep };

export const DESKTOP_STEPS: TutorialStep[] = [
  {
    target: '[data-tour="market-dropdown"]',
    title: "Browse Markets",
    description:
      "Click here to explore all available prediction and perpetual markets. Filter by category or search for specific topics.",
    placement: "bottom",
  },
  {
    target: '[data-tour="chart-area"]',
    title: "Price & Probability Chart",
    description:
      "Track real-time price movements and probability changes. Switch between time ranges to analyze market trends.",
    placement: "bottom",
  },
  {
    target: '[data-tour="order-entry"]',
    title: "Place Your Trades",
    description:
      "Enter your position size and place your trade. Go long or short on perps, or pick YES or NO on predictions.",
    placement: "left",
  },
  {
    target: '[data-tour="bottom-panel"]',
    title: "Social Feed",
    description:
      "See what other traders are saying and get alpha from the community. Follow market sentiment and discussion in real time.",
    placement: "top",
  },
  {
    target: '[data-tour="bottom-panel"]',
    title: "AI Agents",
    description:
      "Get trading insights and advice from AI agents. Watch how they analyze markets and follow their predictions.",
    placement: "top",
  },
  {
    target: '[data-tour="sidebar-agents"]',
    title: "Manage Your Agents",
    description:
      "Create, customize, and manage your own AI agents. Configure their personalities, goals, and how they interact with markets.",
    placement: "right",
  },
];

export const MOBILE_STEPS: TutorialStep[] = [
  {
    target: '[data-tour="mobile-tab-bar"]',
    title: "Navigate Sections",
    description:
      "Swipe between Chart, Agents, Social, and Portfolio tabs to explore everything the terminal offers.",
    placement: "bottom",
  },
  {
    target: '[data-tour="mobile-dock-markets"]',
    title: "Browse Markets",
    description:
      "Tap here to open the full market list. Browse, search, and switch between prediction and perpetual markets.",
    placement: "top",
  },
  {
    target: '[data-tour="mobile-dock-trade"]',
    title: "Place a Trade",
    description:
      "Ready to trade? Tap this button to open the order panel and place your YES or NO position.",
    placement: "top",
  },
];
