/**
 * Game Onboarding Constants
 *
 * Shared constants for the game onboarding/tutorial system.
 * Used by both backend services and frontend components.
 */

/**
 * Game onboarding step types
 */
export type GameOnboardingStep =
  | "welcome"
  | "explore_feed"
  | "follow_npc"
  | "view_markets"
  | "first_prediction"
  | "first_trade"
  | "complete";

/**
 * Points awarded for each onboarding step
 */
export const ONBOARDING_STEP_POINTS: Record<GameOnboardingStep, number> = {
  welcome: 10,
  explore_feed: 20,
  follow_npc: 30,
  view_markets: 20,
  first_prediction: 50,
  first_trade: 50,
  complete: 0, // No points for completion marker
};

/**
 * Order of onboarding steps
 */
export const ONBOARDING_STEP_ORDER: GameOnboardingStep[] = [
  "welcome",
  "explore_feed",
  "follow_npc",
  "view_markets",
  "first_prediction",
  "first_trade",
  "complete",
];

/**
 * Total points available from completing all onboarding steps
 */
export const TOTAL_ONBOARDING_POINTS = Object.values(
  ONBOARDING_STEP_POINTS,
).reduce((sum, points) => sum + points, 0);

/**
 * Display information for each onboarding step
 */
export const ONBOARDING_STEP_INFO: Record<
  GameOnboardingStep,
  { title: string; description: string; points: number }
> = {
  welcome: {
    title: "Welcome to Polyagent!",
    description: "Learn how to navigate the game and start trading.",
    points: ONBOARDING_STEP_POINTS.welcome,
  },
  explore_feed: {
    title: "Explore the Feed",
    description: "Scroll through the feed to see what NPCs are saying.",
    points: ONBOARDING_STEP_POINTS.explore_feed,
  },
  follow_npc: {
    title: "Follow an NPC",
    description: "Follow an NPC to see their posts in your feed.",
    points: ONBOARDING_STEP_POINTS.follow_npc,
  },
  view_markets: {
    title: "View Markets",
    description: "Check out the prediction and perpetual markets.",
    points: ONBOARDING_STEP_POINTS.view_markets,
  },
  first_prediction: {
    title: "Make Your First Prediction",
    description: "Buy shares in a prediction market.",
    points: ONBOARDING_STEP_POINTS.first_prediction,
  },
  first_trade: {
    title: "Make Your First Trade",
    description: "Open a position in the perpetuals market.",
    points: ONBOARDING_STEP_POINTS.first_trade,
  },
  complete: {
    title: "Onboarding Complete!",
    description: `Congratulations! You have earned ${TOTAL_ONBOARDING_POINTS} points from completing all tutorial steps.`,
    points: ONBOARDING_STEP_POINTS.complete,
  },
};

/**
 * Get the next step after completing a step
 */
export function getNextOnboardingStep(
  currentStep: GameOnboardingStep,
): GameOnboardingStep {
  const currentIndex = ONBOARDING_STEP_ORDER.indexOf(currentStep);
  if (currentIndex === -1 || currentIndex >= ONBOARDING_STEP_ORDER.length - 1) {
    return "complete";
  }
  return ONBOARDING_STEP_ORDER[currentIndex + 1]!;
}
