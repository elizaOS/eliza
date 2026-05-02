import {
  type BirthData,
  type ChartAspect,
  calculateNatalChart,
  calculateSunSign,
  type NatalChart,
  type PlanetPosition,
} from "./chart.js";
import {
  buildAspectInterpretationPrompt,
  buildAstrologySynthesisPrompt,
  buildChartOverviewPrompt,
  buildPlanetInterpretationPrompt,
  type FeedbackEntry,
} from "./interpreter.js";
import type { SignPosition } from "./zodiac.js";

export interface AstrologyReadingState {
  birthData: BirthData;
  chart: NatalChart;
  revealOrder: string[];
  revealedPlanets: string[];
  revealIndex: number;
  overviewPresented: boolean;
  feedback: FeedbackEntry[];
  startedAt: number;
}

/**
 * Sun -> Moon -> Ascendant -> personal planets -> social planets -> outer planets
 */
const DEFAULT_REVEAL_ORDER: readonly string[] = [
  "sun",
  "moon",
  "ascendant",
  "mercury",
  "venus",
  "mars",
  "jupiter",
  "saturn",
  "uranus",
  "neptune",
  "pluto",
];

/** Stateless — all reading state lives in AstrologyReadingState objects. */
export class AstrologyEngine {
  startReading(birthData: BirthData): AstrologyReadingState {
    const chart = calculateNatalChart(birthData);

    return {
      birthData,
      chart,
      revealOrder: [...DEFAULT_REVEAL_ORDER],
      revealedPlanets: [],
      revealIndex: 0,
      overviewPresented: false,
      feedback: [],
      startedAt: Date.now(),
    };
  }

  getNextReveal(state: AstrologyReadingState): { planet: string; prompt: string } | null {
    // First reveal is always the overview
    if (!state.overviewPresented) {
      state.overviewPresented = true;
      return {
        planet: "overview",
        prompt: buildChartOverviewPrompt(state.chart, state.feedback),
      };
    }

    if (state.revealIndex >= state.revealOrder.length) {
      return null;
    }

    const planetId = state.revealOrder[state.revealIndex];
    state.revealIndex++;
    state.revealedPlanets.push(planetId);

    // Special handling for ascendant (it's a SignPosition, not a PlanetPosition)
    if (planetId === "ascendant") {
      const ascPos: PlanetPosition = {
        planet: "ascendant",
        sign: state.chart.ascendant.sign,
        degrees: state.chart.ascendant.degrees,
        totalDegrees: state.chart.ascendant.totalDegrees,
        house: 1,
        retrograde: false,
      };
      return {
        planet: "ascendant",
        prompt: buildAscendantPrompt(ascPos, state.chart, state.feedback),
      };
    }

    const position = getChartPosition(planetId, state.chart);
    if (!position) return this.getNextReveal(state); // skip unknown

    return {
      planet: planetId,
      prompt: buildPlanetInterpretationPrompt(position, state.chart, state.feedback),
    };
  }

  recordFeedback(state: AstrologyReadingState, feedback: FeedbackEntry): AstrologyReadingState {
    return {
      ...state,
      feedback: [...state.feedback, { ...feedback, timestamp: Date.now() }],
    };
  }

  getSynthesis(state: AstrologyReadingState): string {
    return buildAstrologySynthesisPrompt(state.chart, state.revealedPlanets, state.feedback);
  }

  getAspectInterpretation(state: AstrologyReadingState, aspect: ChartAspect): string {
    return buildAspectInterpretationPrompt(aspect, state.chart, state.feedback);
  }

  getSunSign(month: number, day: number): string {
    return calculateSunSign(month, day);
  }

  computeChart(birthData: BirthData): NatalChart {
    return calculateNatalChart(birthData);
  }
}

function getChartPosition(planetId: string, chart: NatalChart): PlanetPosition | undefined {
  const key = planetId as keyof NatalChart;
  const val = chart[key];
  if (val && typeof val === "object" && "planet" in val) {
    return val as PlanetPosition;
  }
  return undefined;
}

function buildAscendantPrompt(
  position: PlanetPosition,
  chart: NatalChart,
  feedback: FeedbackEntry[]
): string {
  const signName = position.sign.charAt(0).toUpperCase() + position.sign.slice(1);

  const feedbackSection =
    feedback.length > 0
      ? `\n\n## User Feedback So Far\n${feedback.map((f) => `- Re: ${f.topic}: "${f.response}"`).join("\n")}`
      : "";

  return `You are an insightful, warm, and articulate astrologer continuing a natal chart reading. Address the querent directly as "you."

## The Ascendant: ${signName} Rising

**Position:** ${signName} at ${position.degrees.toFixed(1)}\u00B0

The Ascendant (or Rising Sign) is the zodiac sign that was rising on the eastern horizon at the exact moment of your birth. It is arguably the most personal point in the chart \u2014 it determines how the world sees you, your instinctive approach to new situations, and the "mask" you wear in public.

### ${signName} Rising
A ${signName} Ascendant means you enter the world ${signName}-first. This shapes your physical presence, your first impressions, and the way you instinctively navigate new environments.

### The Sun-Moon-Rising Triad
- **Sun in ${chart.sun.sign.charAt(0).toUpperCase() + chart.sun.sign.slice(1)}:** Your core identity
- **Moon in ${chart.moon.sign.charAt(0).toUpperCase() + chart.moon.sign.slice(1)}:** Your emotional inner world  
- **Rising in ${signName}:** The lens through which both are expressed

## Your Task
Provide a vivid, personal interpretation of this ${signName} Ascendant. Cover:
1. How this Rising sign shapes the querent\u2019s appearance, demeanor, and first impressions
2. How it interacts with their Sun and Moon signs to create a unique persona
3. What it means for their approach to life and new beginnings
4. Any tension or harmony between the Rising sign and the rest of the chart

Keep it to 2-3 paragraphs. Be specific and insightful.${feedbackSection}`;
}

export type { BirthData, NatalChart, PlanetPosition, ChartAspect, SignPosition, FeedbackEntry };

export {
  calculateAspects,
  calculateNatalChart,
  calculateSunSign,
} from "./chart.js";
export {
  buildAspectInterpretationPrompt,
  buildAstrologySynthesisPrompt,
  buildChartOverviewPrompt,
  buildPlanetInterpretationPrompt,
} from "./interpreter.js";
export {
  degreesToSign,
  getAspectDefinitions,
  getElement,
  getModality,
  getRulingPlanet,
  isAspect,
  SIGN_ORDER,
  signDisplayName,
} from "./zodiac.js";
