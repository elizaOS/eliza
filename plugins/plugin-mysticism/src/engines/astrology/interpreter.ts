/**
 * LLM interpretation prompt builders for natal chart readings.
 *
 * These functions construct rich, context-aware prompts that an LLM can use
 * to generate personalised astrological interpretations. They incorporate
 * chart data, previously revealed information, and user feedback to create
 * a coherent, evolving reading experience.
 */

import type { ChartAspect, NatalChart, PlanetPosition } from "./chart.js";
import planetsData from "./data/planets.json" with { type: "json" };
import { getElement, getModality, signDisplayName } from "./zodiac.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeedbackEntry {
  /** Which planet/aspect this feedback relates to */
  topic: string;
  /** The user's reaction or comment */
  response: string;
  /** How much the user resonated (1-5, if provided) */
  resonance?: number;
  /** Timestamp of when feedback was given */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PlanetData {
  id: string;
  name: string;
  symbol: string;
  keywords: string[];
  description: string;
  meaningsInSigns: Record<string, string>;
}

function getPlanetData(planetId: string): PlanetData | undefined {
  return (planetsData as PlanetData[]).find((p) => p.id === planetId);
}

function formatPosition(pos: PlanetPosition): string {
  const retroLabel = pos.retrograde ? " (retrograde)" : "";
  return `${signDisplayName(pos.sign)} at ${pos.degrees.toFixed(1)}\u00B0${retroLabel}, House ${pos.house}`;
}

function formatFeedback(feedback: FeedbackEntry[]): string {
  if (feedback.length === 0) return "";

  const lines = feedback.map((f) => {
    const resonanceLabel = f.resonance !== undefined ? ` [resonance: ${f.resonance}/5]` : "";
    return `- Re: ${f.topic}${resonanceLabel}: "${f.response}"`;
  });

  return `\n\n## User Feedback So Far\nThe querent has shared the following reactions to previous reveals. Use these to calibrate your interpretation \u2014 lean into themes that resonate and gently explore areas of resistance.\n${lines.join("\n")}`;
}

function listAspectsFor(planet: string, chart: NatalChart): string {
  const relevant = chart.aspects.filter((a) => a.planet1 === planet || a.planet2 === planet);
  if (relevant.length === 0) return "No major aspects.";

  return relevant
    .map((a) => {
      const other = a.planet1 === planet ? a.planet2 : a.planet1;
      return `${a.aspectName} (${a.aspectSymbol}) to ${signDisplayName(other)} (orb: ${a.orb}\u00B0, ${a.nature})`;
    })
    .join("; ");
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/**
 * Build a comprehensive chart overview prompt that introduces the reading
 * and sets the tone for the session.
 */
export function buildChartOverviewPrompt(chart: NatalChart, feedback: FeedbackEntry[]): string {
  const sunData = getPlanetData("sun");
  const moonData = getPlanetData("moon");

  const elementCounts: Record<string, number> = { fire: 0, earth: 0, air: 0, water: 0 };
  const modalityCounts: Record<string, number> = { cardinal: 0, fixed: 0, mutable: 0 };

  const positions = [
    chart.sun,
    chart.moon,
    chart.mercury,
    chart.venus,
    chart.mars,
    chart.jupiter,
    chart.saturn,
    chart.uranus,
    chart.neptune,
    chart.pluto,
  ];

  for (const pos of positions) {
    const el = getElement(pos.sign);
    const mod = getModality(pos.sign);
    elementCounts[el]++;
    modalityCounts[mod]++;
  }

  const dominantElement = Object.entries(elementCounts).sort((a, b) => b[1] - a[1])[0];
  const dominantModality = Object.entries(modalityCounts).sort((a, b) => b[1] - a[1])[0];

  return `You are an insightful, warm, and articulate astrologer giving a natal chart reading. Speak with authority but also compassion. Use vivid language and metaphor. Address the querent directly as "you."

## Chart Overview

**Sun:** ${formatPosition(chart.sun)}
**Moon:** ${formatPosition(chart.moon)}
**Ascendant:** ${signDisplayName(chart.ascendant.sign)} at ${chart.ascendant.degrees.toFixed(1)}\u00B0
**Midheaven:** ${signDisplayName(chart.midheaven.sign)} at ${chart.midheaven.degrees.toFixed(1)}\u00B0

### Elemental Balance
- Fire: ${elementCounts.fire} planets | Earth: ${elementCounts.earth} planets
- Air: ${elementCounts.air} planets | Water: ${elementCounts.water} planets
- **Dominant element:** ${dominantElement[0]} (${dominantElement[1]} placements)

### Modal Balance
- Cardinal: ${modalityCounts.cardinal} | Fixed: ${modalityCounts.fixed} | Mutable: ${modalityCounts.mutable}
- **Dominant modality:** ${dominantModality[0]} (${dominantModality[1]} placements)

### Sun in ${signDisplayName(chart.sun.sign)}
${sunData?.meaningsInSigns[chart.sun.sign] ?? ""}

### Moon in ${signDisplayName(chart.moon.sign)}
${moonData?.meaningsInSigns[chart.moon.sign] ?? ""}

## Your Task
Provide a warm, engaging overview of this chart. Cover:
1. The "Big Three" (Sun, Moon, Rising) and what this combination suggests about the person
2. The elemental and modal balance and what it means for their temperament
3. Any immediately striking patterns (clusters, oppositions, dominant themes)

Keep it to 3-4 paragraphs. End with a natural transition that invites the querent to explore further.${formatFeedback(feedback)}`;
}

/**
 * Build a detailed interpretation prompt for a specific planet placement.
 */
export function buildPlanetInterpretationPrompt(
  position: PlanetPosition,
  chart: NatalChart,
  feedback: FeedbackEntry[]
): string {
  const planetData = getPlanetData(position.planet);
  if (!planetData) {
    return `Interpret the placement of ${position.planet} in ${signDisplayName(position.sign)}.`;
  }

  const signMeaning = planetData.meaningsInSigns[position.sign] ?? "";
  const aspects = listAspectsFor(position.planet, chart);

  return `You are an insightful, warm, and articulate astrologer continuing a natal chart reading. Speak with authority but also compassion. Use vivid language and metaphor. Address the querent directly as "you."

## ${planetData.name} (${planetData.symbol}) in ${signDisplayName(position.sign)}

**Position:** ${formatPosition(position)}
**Keywords:** ${planetData.keywords.join(", ")}
**Planet significance:** ${planetData.description}

### Sign Meaning
${signMeaning}

### Aspects
${aspects}

### House ${position.house} Context
This placement falls in the ${ordinal(position.house)} house, which governs the life areas associated with that house. Consider how this planet\u2019s energy expresses itself through this house\u2019s domain.

${position.retrograde ? `### Retrograde\nThis planet is retrograde, suggesting its energy is turned inward. The themes of ${planetData.name} are experienced more internally, with a need for reflection and re-evaluation before outward expression.\n` : ""}

## Your Task
Provide a rich, personal interpretation of this placement. Cover:
1. What this planet in this sign means for the querent\u2019s life
2. How the house placement colours the expression
3. What the aspects suggest about how this energy interacts with other parts of their chart
4. Practical wisdom or reflection questions for the querent

Keep it to 2-3 paragraphs. Be specific and insightful, not generic.${formatFeedback(feedback)}`;
}

/**
 * Build an interpretation prompt for a specific aspect between two planets.
 */
export function buildAspectInterpretationPrompt(
  aspect: ChartAspect,
  chart: NatalChart,
  feedback: FeedbackEntry[]
): string {
  const p1Data = getPlanetData(aspect.planet1);
  const p2Data = getPlanetData(aspect.planet2);

  const p1Pos = getPositionFromChart(aspect.planet1, chart);
  const p2Pos = getPositionFromChart(aspect.planet2, chart);

  return `You are an insightful, warm, and articulate astrologer continuing a natal chart reading. Address the querent directly as "you."

## ${aspect.aspectName} (${aspect.aspectSymbol}): ${p1Data?.name ?? aspect.planet1} ${aspect.aspectSymbol} ${p2Data?.name ?? aspect.planet2}

**Nature:** ${aspect.nature}
**Exact separation:** ${aspect.actualDegrees.toFixed(1)}\u00B0 (orb: ${aspect.orb}\u00B0)

### ${p1Data?.name ?? aspect.planet1}
- **Position:** ${p1Pos ? formatPosition(p1Pos) : "unknown"}
- **Keywords:** ${p1Data?.keywords.join(", ") ?? ""}

### ${p2Data?.name ?? aspect.planet2}
- **Position:** ${p2Pos ? formatPosition(p2Pos) : "unknown"}
- **Keywords:** ${p2Data?.keywords.join(", ") ?? ""}

## Your Task
Interpret this aspect in the context of the querent\u2019s life. Cover:
1. How these two planetary energies interact through this aspect type
2. What tensions or gifts this creates
3. How this might manifest in daily life or key life themes
4. Constructive ways to work with this energy

Keep it to 2 paragraphs. Be specific and meaningful.${formatFeedback(feedback)}`;
}

/**
 * Build a synthesis prompt that weaves together all revealed placements
 * into a cohesive narrative.
 */
export function buildAstrologySynthesisPrompt(
  chart: NatalChart,
  revealedPlanets: string[],
  feedback: FeedbackEntry[]
): string {
  const revealed = revealedPlanets.map((pid) => {
    const pos = getPositionFromChart(pid, chart);
    const data = getPlanetData(pid);
    if (!pos || !data) return `- ${pid}: unknown`;
    return `- **${data.name}** in ${signDisplayName(pos.sign)} (House ${pos.house})${pos.retrograde ? " R" : ""}: ${data.meaningsInSigns[pos.sign] ?? ""}`;
  });

  const significantAspects = chart.aspects
    .filter((a) => revealedPlanets.includes(a.planet1) && revealedPlanets.includes(a.planet2))
    .filter((a) => a.orb <= 5)
    .slice(0, 8)
    .map((a) => `- ${a.planet1} ${a.aspectName} ${a.planet2} (${a.nature}, orb: ${a.orb}\u00B0)`);

  return `You are an insightful, warm, and articulate astrologer delivering the synthesis of a natal chart reading. This is the culminating moment \u2014 weave everything together into a meaningful narrative. Address the querent directly as "you."

## Placements Explored
${revealed.join("\n")}

## Key Aspects
${significantAspects.length > 0 ? significantAspects.join("\n") : "No tight aspects between revealed planets."}

## Ascendant & Midheaven
- **Rising:** ${signDisplayName(chart.ascendant.sign)} at ${chart.ascendant.degrees.toFixed(1)}\u00B0
- **MC:** ${signDisplayName(chart.midheaven.sign)} at ${chart.midheaven.degrees.toFixed(1)}\u00B0

## Your Task
Deliver a powerful, cohesive synthesis of this person\u2019s chart. This should:
1. Identify the 2-3 core themes that run through the chart
2. Show how different placements reinforce, challenge, or balance each other
3. Paint a picture of the person\u2019s gifts, challenges, and growth path
4. Offer empowering insights about their life purpose and potential
5. Close with an inspiring, memorable statement that honours the whole chart

Keep it to 4-5 paragraphs. This should feel like a culminating revelation, not a list. Make it deeply personal and meaningful.${formatFeedback(feedback)}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getPositionFromChart(planetId: string, chart: NatalChart): PlanetPosition | undefined {
  const key = planetId as keyof NatalChart;
  const val = chart[key];
  if (val && typeof val === "object" && "planet" in val) {
    return val as PlanetPosition;
  }
  return undefined;
}

function ordinal(n: number): string {
  const suffixes = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
}
