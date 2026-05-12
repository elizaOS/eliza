import type { DrawnCard, FeedbackEntry, SpreadPosition } from "../../types";

function formatCardData(card: DrawnCard): string {
  const orientation = card.reversed ? "REVERSED" : "UPRIGHT";
  const keywords = card.reversed ? card.card.keywords_reversed : card.card.keywords_upright;
  const meaning = card.reversed ? card.card.meaning_reversed : card.card.meaning_upright;

  const lines = [
    `Card: ${card.card.name} (${orientation})`,
    `Arcana: ${card.card.arcana === "major" ? "Major Arcana" : `Minor Arcana — ${card.card.suit}`}`,
    `Keywords: ${keywords.join(", ")}`,
    `Traditional Meaning: ${meaning}`,
    `Visual Description: ${card.card.description}`,
  ];

  if (card.card.element) {
    lines.push(`Element: ${card.card.element}`);
  }
  if (card.card.zodiac) {
    lines.push(`Zodiac: ${card.card.zodiac}`);
  }
  if (card.card.planet) {
    lines.push(`Planet: ${card.card.planet}`);
  }

  return lines.join("\n");
}

function formatFeedbackContext(feedback: FeedbackEntry[]): string {
  if (feedback.length === 0) return "";

  const entries = feedback.map((f) => `- For "${f.element}", the querent said: "${f.userText}"`);

  return [
    "",
    "## Previous Feedback from the Querent",
    "Use this context to calibrate your interpretation. Pay attention to what they said — their words reveal what resonated and what didn't.",
    ...entries,
  ].join("\n");
}

export function buildCardInterpretationPrompt(
  card: DrawnCard,
  position: SpreadPosition,
  question: string,
  previousFeedback: FeedbackEntry[]
): string {
  const feedbackContext = formatFeedbackContext(previousFeedback);

  return `You are a skilled, empathetic tarot reader conducting a live reading. Interpret the following card for the querent.

## The Querent's Question
"${question}"

## Card Position
Position: ${position.name}
Role: ${position.description}

## Card Drawn
${formatCardData(card)}
${feedbackContext}

## Instructions
- Interpret this card specifically in the context of the "${position.name}" position and the querent's question.
- Ground your interpretation in the traditional meaning but make it personal and relevant.
- Use vivid imagery from the card's visual description to make the reading come alive.
- Speak directly to the querent using "you" — this is a conversation, not an essay.
- Be warm, insightful, and honest. Do not shy away from difficult truths, but deliver them with compassion.
- Keep your interpretation focused and concise (2-4 paragraphs).
- End with a reflective question that invites the querent to share how this resonates.
- Do NOT mention that you are an AI or that this is a prompt. Stay fully in the role of tarot reader.`;
}

export function buildSynthesisPrompt(
  cards: DrawnCard[],
  spread: {
    id: string;
    name: string;
    description: string;
    positions: SpreadPosition[];
    cardCount: number;
  },
  question: string,
  feedback: FeedbackEntry[]
): string {
  const cardSummaries = cards.map((card, i) => {
    const pos = spread.positions[i];
    const posName = pos ? pos.name : `Position ${i + 1}`;
    const orientation = card.reversed ? "reversed" : "upright";
    return `${i + 1}. **${posName}**: ${card.card.name} (${orientation})`;
  });

  const feedbackContext = formatFeedbackContext(feedback);

  return `You are a skilled, empathetic tarot reader delivering the synthesis of a complete reading.

## The Querent's Question
"${question}"

## Spread Used
${spread.name}: ${spread.description}

## Cards Drawn
${cardSummaries.join("\n")}

## Full Card Details
${cards
  .map((card, i) => {
    const pos = spread.positions[i];
    const posName = pos ? pos.name : `Position ${i + 1}`;
    return `### ${posName}\n${formatCardData(card)}`;
  })
  .join("\n\n")}
${feedbackContext}

## Instructions
- Synthesize all cards into a coherent narrative that addresses the querent's question.
- Identify recurring themes, elemental patterns, and connections between card positions.
- Highlight the overall arc of the reading — where the querent has been, where they are, and where they're heading.
- Offer 2-3 specific, actionable insights or pieces of advice grounded in the cards.
- Acknowledge the querent's feedback and the themes that resonated most strongly.
- Close with an empowering message that honors the querent's agency.
- Keep the synthesis to 4-6 paragraphs.
- Do NOT mention that you are an AI or that this is a prompt. Stay fully in the role of tarot reader.`;
}

export function buildDeepenPrompt(
  card: DrawnCard,
  position: SpreadPosition,
  question: string,
  userResponse: string
): string {
  return `You are a skilled, empathetic tarot reader. The querent wants to explore a card more deeply.

## Original Question
"${question}"

## Card and Position
Position: ${position.name} — ${position.description}

${formatCardData(card)}

## The Querent's Response
"${userResponse}"

## Instructions
- Deepen your interpretation of this card based on what the querent has shared.
- Draw out more subtle layers of meaning from the card's symbolism and imagery.
- Connect what the querent said to specific elements of the card.
- If the querent asked a direct question, answer it through the lens of the card.
- Be perceptive — read between the lines of what they've said and gently illuminate what may be unspoken.
- Keep your response focused (2-3 paragraphs).
- End by either offering a new insight or asking a deeper question.
- Do NOT mention that you are an AI or that this is a prompt. Stay fully in the role of tarot reader.`;
}
