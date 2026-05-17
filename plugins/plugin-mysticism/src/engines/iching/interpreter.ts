import type { FeedbackEntry, Hexagram } from "../../types.js";
import { getLowerTrigram, getUpperTrigram } from "./divination.js";

function formatHexagramVisual(hexagram: Hexagram, changingLines: number[]): string {
  const lines: string[] = [];
  // Display from top (line 6) to bottom (line 1) — traditional order
  for (let i = 5; i >= 0; i--) {
    const bit = hexagram.binary[i];
    const position = i + 1;
    const isChanging = changingLines.includes(position);
    const lineChar = bit === "1" ? "━━━━━━━━━" : "━━━━ ━━━━";
    const marker = isChanging ? " ◯" : "  ";
    lines.push(`  ${lineChar}${marker}  ← Line ${position}`);
  }
  return lines.join("\n");
}

function formatFeedback(feedback: FeedbackEntry[]): string {
  if (feedback.length === 0) return "";

  const entries = feedback.map((f) => `- For "${f.element}", the querent said: "${f.userText}"`);

  return `\n## User Feedback So Far\n${entries.join("\n")}`;
}

function formatTrigramContext(hexagram: Hexagram): string {
  const upper = getUpperTrigram(hexagram);
  const lower = getLowerTrigram(hexagram);

  return [
    `Upper Trigram: ${upper.character} ${upper.name} (${upper.englishName}) — ${upper.image}, ${upper.attribute}`,
    `Lower Trigram: ${lower.character} ${lower.name} (${lower.englishName}) — ${lower.image}, ${lower.attribute}`,
    `Element interaction: ${lower.element} (below) meets ${upper.element} (above)`,
  ].join("\n");
}

export function buildHexagramPrompt(
  hexagram: Hexagram,
  question: string,
  changingLines: number[],
  transformedHexagram: Hexagram | null,
  revealedLines: number,
  feedback: FeedbackEntry[]
): string {
  const visual = formatHexagramVisual(hexagram, changingLines);
  const trigramCtx = formatTrigramContext(hexagram);
  const feedbackSection = formatFeedback(feedback);

  const changingSection =
    changingLines.length > 0
      ? `\nChanging Lines: ${changingLines.map((l) => `Line ${l}`).join(", ")}`
      : "\nNo changing lines — this situation is stable.";

  const transformSection = transformedHexagram
    ? `\n## Transformed Hexagram\n${transformedHexagram.character} Hexagram ${transformedHexagram.number}: ${transformedHexagram.name} (${transformedHexagram.englishName})\n${transformedHexagram.judgment}\n\nThis is where the situation is moving toward.`
    : "";

  return `You are an I Ching reader providing a thoughtful, personalized interpretation.

## The Question
"${question}"

## Primary Hexagram
${hexagram.character} Hexagram ${hexagram.number}: ${hexagram.name} (${hexagram.englishName})

${visual}

### Trigrams
${trigramCtx}

### Judgment
${hexagram.judgment}

### Image
${hexagram.image}
${changingSection}

### Keywords
${hexagram.keywords.join(", ")}

### Essence
${hexagram.description}

### Lines Revealed So Far: ${revealedLines} of 6
${transformSection}
${feedbackSection}

## Instructions
Interpret this hexagram in relation to the querent's question. Be specific and personal, not generic. Weave the trigram imagery and the judgment together into practical wisdom. Speak with the warmth and gravity of a wise counselor, not a textbook. Keep it concise (2-4 paragraphs) but profound.

If there are changing lines, acknowledge that transformation is at work, but save detailed line interpretations for later — focus on the overall picture of the primary hexagram.

If user feedback is available, honor what resonated and gently reframe what did not. Build on established threads of meaning.`;
}

export function buildLinePrompt(
  hexagram: Hexagram,
  linePosition: number,
  question: string,
  feedback: FeedbackEntry[]
): string {
  const line = hexagram.lines.find((l) => l.position === linePosition);
  if (!line) {
    throw new Error(`Line position ${linePosition} not found in hexagram ${hexagram.number}`);
  }

  const feedbackSection = formatFeedback(feedback);
  const isYang = hexagram.binary[linePosition - 1] === "1";
  const lineType = isYang
    ? "yang (solid) changing to yin (broken)"
    : "yin (broken) changing to yang (solid)";

  return `You are an I Ching reader interpreting a specific changing line.

## Context
The querent asked: "${question}"
Primary Hexagram: ${hexagram.character} ${hexagram.name} (${hexagram.englishName})

## Changing Line ${linePosition} of 6
Type: ${lineType}

### Traditional Text
"${line.text}"

### Traditional Meaning
${line.meaning}

### Position Significance
Line ${linePosition} ${describeLinePosition(linePosition)}
${feedbackSection}

## Instructions
Interpret this specific changing line in the context of the querent's question. The changing line represents a point of active transformation in their situation.

Connect the line's imagery to their practical situation. Be vivid and specific. Use the line's position meaning (${describeLinePosition(linePosition)}) to add depth.

Keep it to 1-2 focused paragraphs. End with a question that helps the querent reflect on how this line applies to their situation.`;
}

export function buildIChingSynthesisPrompt(
  hexagram: Hexagram,
  transformedHexagram: Hexagram | null,
  changingLines: number[],
  question: string,
  feedback: FeedbackEntry[]
): string {
  const feedbackSection = formatFeedback(feedback);
  const trigramCtx = formatTrigramContext(hexagram);

  const changingLineTexts = changingLines
    .map((pos) => {
      const line = hexagram.lines.find((l) => l.position === pos);
      return line
        ? `- Line ${pos}: "${line.text}" — ${line.meaning}`
        : `- Line ${pos}: (text unavailable)`;
    })
    .join("\n");

  const transformSection = transformedHexagram
    ? `\n## The Transformation
From: ${hexagram.character} ${hexagram.name} (${hexagram.englishName})
To:   ${transformedHexagram.character} ${transformedHexagram.name} (${transformedHexagram.englishName})

The transformed hexagram represents where the situation is heading:
${transformedHexagram.judgment}

${transformedHexagram.description}`
    : `\n## Stability
No changing lines were cast. This situation has a stable, settled quality. The hexagram speaks to a condition rather than a transition.`;

  return `You are an I Ching reader delivering the final synthesis of a reading.

## The Question
"${question}"

## Primary Hexagram
${hexagram.character} Hexagram ${hexagram.number}: ${hexagram.name} (${hexagram.englishName})

### Trigrams
${trigramCtx}

### Judgment
${hexagram.judgment}

### Image
${hexagram.image}

### Essence
${hexagram.description}

## Changing Lines
${changingLines.length > 0 ? changingLineTexts : "None — the reading is stable."}
${transformSection}
${feedbackSection}

## Instructions
Deliver a final synthesis that weaves together all elements of this reading into a coherent, actionable message. This is the culmination of the entire consultation.

Structure your synthesis:
1. **The Core Message** — The single most important insight from this reading.
2. **The Movement** — What is changing (or what is stable) and why it matters.
3. **Practical Wisdom** — Specific, actionable guidance drawn from the hexagram's teachings.
4. **A Parting Image** — A vivid metaphor or image from the reading that the querent can carry with them.

Honor the user's feedback throughout. Where things resonated, deepen. Where they did not, offer a new angle. Be warm, specific, and wise. Avoid platitudes. Speak as if this is the most important reading you have ever given.

Keep it to 3-5 paragraphs. End with something memorable.`;
}

function describeLinePosition(position: number): string {
  switch (position) {
    case 1:
      return "represents the beginning, the entry point, or the foundation of the situation. It is the first stirring of the theme.";
    case 2:
      return "represents the inner world, the official in service, or the center of the lower trigram. It shows the optimal response from within.";
    case 3:
      return "represents the transition from inner to outer, a place of danger and difficulty. It is the top of the lower trigram, where the internal meets the external.";
    case 4:
      return "represents the entry into the outer or public sphere, the minister near the ruler. It is the bottom of the upper trigram, a place of cautious advancement.";
    case 5:
      return "represents the ruler's position, the place of greatest authority and influence. It is the center of the upper trigram, the seat of power.";
    case 6:
      return "represents the conclusion, the sage who has gone beyond, or the situation at its extreme. It warns of excess or the transition to something entirely new.";
    default:
      return "is at an unrecognized position.";
  }
}
