import { definePrompt } from '../define-prompt';
import { PARODY_NAME_RULES } from '../shared-sections';

/**
 * Prompt for generating announcement posts for significant stock price movements.
 *
 * Creates announcement posts reporting significant stock price changes for
 * companies. Used to notify players of major market movements and their
 * potential causes. Includes narrative context for connected market coverage.
 *
 * Returns XML with price announcement post.
 */
export const priceAnnouncement = definePrompt({
  id: 'price-announcement',
  version: '3.0.0',
  category: 'game',
  description: 'Price announcements with narrative context',
  temperature: 0.7,
  maxTokens: 500,
  template: `{{realityGrounding}}

The current date is {{currentDate}}. Always act as though it is the current date.

=== MARKET CONTEXT ===
{{richGameContext}}

=== PREVIOUS PRICE MOVES ===
{{previousPriceMoves}}

=== THIS PRICE MOVEMENT ===
COMPANY: {{companyName}}
PRICE CHANGE: {{priceChange}}% ({{direction}})
CURRENT PRICE: \${{currentPrice}}
EVENT CONTEXT: {{eventDescription}}

=== CONNECTED STORYLINES ===
{{connectedNarratives}}

${PARODY_NAME_RULES}

Generate a brief announcement post about this price movement.

Requirements:
- One sentence, max 200 characters
- Mention the price change and direction
- Reference the triggering event if relevant
- Satirical but professional tone
- No hashtags or emojis

VALUE RANGES:
- sentiment: -1 (very negative) to 1 (very positive)

Respond with ONLY this XML:
<response>
  <post>Your price announcement here</post>
  <sentiment>0.5</sentiment>
</response>

No other text.
`.trim(),
});
