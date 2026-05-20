import { definePrompt } from '../define-prompt';
import {
  CONTENT_REQUIREMENTS_MARKET,
  FINAL_REMINDERS,
  WORLD_CONTEXT_HEADER_WITH_TRADES,
} from '../shared-sections';

/**
 * Prompt for generating stock ticker style posts for price movements.
 *
 * Creates brief, ticker-style posts reporting stock price movements
 * and market updates. Uses concise financial reporting format with
 * specific price and percentage change data. Includes context for
 * connecting price moves to narratives.
 *
 * Returns XML with ticker post and price data.
 */
export const stockTicker = definePrompt({
  id: 'stock-ticker',
  version: '4.0.0',
  category: 'feed',
  description: 'Stock ticker posts with narrative connection',
  temperature: 0.6,
  maxTokens: 400,
  template: `{{realityGrounding}}

The current date is {{currentDate}}. Always act as though it is the current date.

=== MARKET CONTEXT ===
Recent market events: {{recentMarketEvents}}
Related questions: {{relatedQuestions}}

=== THIS PRICE MOVEMENT ===
TICKER: {{ticker}}
COMPANY: {{companyName}}
PRICE: \${{currentPrice}}
CHANGE: {{priceChange}}% ({{direction}})
VOLUME: {{volume}}

=== WHY THIS MOVED ===
Event catalyst: {{eventCatalyst}}
Connected storyline: {{connectedNarrative}}

${WORLD_CONTEXT_HEADER_WITH_TRADES}

Create a brief, professional stock ticker post.

Requirements:
- Concise financial reporting style
- Include key numbers
- Max 150 characters
- Professional but can be subtly satirical

${CONTENT_REQUIREMENTS_MARKET}

Example: "{{ticker}} \${{currentPrice}} {{direction}} {{priceChange}}% on news of [brief event mention]"

Respond with ONLY this XML:
<response>
  <post>Your ticker post here</post>
</response>

${FINAL_REMINDERS}

No other text.
`.trim(),
});
