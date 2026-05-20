# Babylon Prompt System

Centralized prompt management for LLM-driven game generation using TypeScript.

## Structure

```
prompts/
├── feed/          # Feed post generation prompts
│   ├── news-posts.ts
│   ├── reactions.ts
│   ├── conspiracy.ts
│   ├── commentary.ts
│   ├── replies.ts
│   ├── ambient-posts.ts
│   └── ...
├── game/          # Game setup prompts
│   ├── scenarios.ts
│   ├── questions.ts
│   ├── day-transition.ts
│   └── ...
├── image/         # Image generation prompts
│   └── ...
├── system/        # System-level prompts
│   └── ...
├── trading/       # Trading-related prompts
│   └── ...
└── world/         # World generation prompts
    ├── news-report.ts
    ├── rumor.ts
    ├── npc-conversation.ts
    └── ...
```

## File Format

Each `.ts` file exports prompt definitions using `definePrompt()`:

```typescript
import { definePrompt } from '../define-prompt';

export const newsPosts = definePrompt({
  id: 'news-posts',
  version: '2.0.0',
  category: 'feed',
  description: 'Generates breaking news posts from media entities',
  temperature: 0.8,
  maxTokens: 2000,
  template: `
Event: {{eventDescription}}
Type: {{eventType}}

WORLD CONTEXT:
{{worldActors}}
{{currentMarkets}}
{{activePredictions}}
{{recentTrades}}

IMPORTANT RULES:
- NO HASHTAGS OR EMOJIS IN POSTS
- NEVER use real names (Elon Musk, Sam Altman, etc.)
- ALWAYS use ONLY parody names from World Actors list (AIlon Musk, Sam AIltman, etc.)

Generate breaking news posts...
  `.trim()
});
```

## Usage

### Basic Usage

```typescript
import { renderPrompt, getPromptParams, newsPosts } from '@/prompts';

// Render prompt with variables
const prompt = renderPrompt(newsPosts, {
  eventDescription: 'TeslAI announces new product',
  eventType: 'product-launch',
  worldActors: '...',
  currentMarkets: '...',
  // ... other variables
});

// Get LLM parameters from prompt definition
const params = getPromptParams(newsPosts);
// { temperature: 0.8, maxTokens: 8000 }

// Use with LLM client
const response = await llm.generateJSON(prompt, undefined, params);
```

### With World Context & Reality Grounding

```typescript
import { generateWorldContext, renderPrompt, getPromptParams, reactions } from '@/prompts';

// Generate world context with reality grounding
const worldContext = await generateWorldContext({ 
  maxActors: 50,
  realityGroundingLevel: 'concise' // 'full' | 'concise' | 'minimal' | 'none'
});

// Render prompt with world context (includes reality grounding automatically)
const prompt = renderPrompt(reactions, {
  eventDescription: '...',
  actorsList: '...',
  ...worldContext  // Spreads: worldActors, currentMarkets, realityGrounding, currentDate, etc.
});

// Use prompt parameters
const params = getPromptParams(reactions);
const response = await llm.generateJSON(prompt, undefined, params);
```

**What's included in worldContext:**
- `worldActors` - List of parody actor names
- `currentMarkets` - Active prediction markets and stock prices
- `activePredictions` - Current questions
- `recentTrades` - Recent trading activity
- `realityGrounding` - Current date, prices, politics, AI state, culture
- `currentDate`, `currentTime`, `currentYear`, etc. - Temporal context

## Key Features

### Prompt Definition Interface

```typescript
interface PromptDefinition {
  id: string;              // Unique identifier
  version: string;          // Semantic version
  category: string;        // 'feed' | 'game' | 'world'
  description: string;     // Human-readable description
  temperature?: number;    // LLM temperature (0-2)
  maxTokens?: number;      // Maximum tokens for response
  template: string;         // Template with {{variables}}
}
```

### Variable Substitution

Variables are substituted using `{{variableName}}` syntax:

```typescript
renderPrompt(newsPosts, {
  eventDescription: 'Breaking news',
  worldActors: 'AIlon Musk, Sam AIltman...',
  // All {{variableName}} in template are replaced
});
```

### LLM Parameters

Use `getPromptParams()` to extract temperature and maxTokens from prompt definitions:

```typescript
const params = getPromptParams(newsPosts);
// Ensures consistency - single source of truth
// Prevents mismatches between template and usage
```

## Reality Grounding System

**NEW**: Prevents LLM from generating outdated predictions based on old training data.

### The Problem
LLMs trained on 2023 data might generate:
- ❌ "Will Bitcoin hit $35K?" (It's already at $95K in Nov 2025)
- ❌ "Will iPhone 15 launch?" (iPhone 17 is current)
- ❌ "President Biden announces..." (Trump is president in 2025)

### The Solution
Reality grounding provides current facts to every prompt:

```typescript
const worldContext = await generateWorldContext({
  realityGroundingLevel: 'concise' // Default for most prompts
});

// worldContext.realityGrounding contains:
// - Current date (November 16, 2025)
// - Crypto prices (BTC: $95K, ETH: $3.2K, SOL: $140)
// - Stock prices (NVDA: $190, META: $610, TSLA: $400-440)
// - Political context (Trump president since Jan 2025)
// - AI state (SMH-5.1, ClAIude 4.5, GeminAI 2.5)
// - Pop culture (iPhone 17, Taylor Swift dominance)
```

### Reality Grounding Levels

- **`full`** - Complete reality context (~2000 tokens) - Use for question generation
- **`concise`** - Key facts only (~500 tokens) - Default for feed generation
- **`minimal`** - One-line summary (~50 tokens) - Use for simple posts
- **`none`** - No reality grounding - Only for system prompts

### Validation

Check generated content for outdated references:

```typescript
import { validateGeneratedContent } from '@/prompts';

const validation = validateGeneratedContent(generatedText);

if (!validation.isValid) {
  console.error('Errors:', validation.errors); // Real names found
}
```

## Important Rules

All prompts must follow these rules:

1. **NEVER use real names** - Always use parody names (AIlon Musk, Sam AIltman, etc.)
2. **NO hashtags or emojis** - Keep content clean and professional
3. **World Context** - Include `{{worldActors}}`, `{{currentMarkets}}`, etc. when available
4. **Reality Grounding** - Include `{{realityGrounding}}` in all content generation prompts
5. **XML Output** - Most prompts require XML-formatted responses
6. **Post-processing** - All outputs are post-processed to replace any real names that slip through

## Benefits

- ✅ **Centralized** - All prompts in one place
- ✅ **Type-safe** - TypeScript ensures correctness
- ✅ **Versionable** - Track prompt changes over time
- ✅ **Testable** - Easy to A/B test prompts
- ✅ **Maintainable** - Separate concerns from code
- ✅ **Consistent** - Single source of truth for parameters
- ✅ **Optimizable** - Reduce retry loops and improve quality

## Best Practices

1. **Always use `getPromptParams()`** - Don't hardcode temperature/maxTokens
2. **Include world context** - Spread `worldContext` into all renderPrompt calls
3. **Post-process outputs** - Use `characterMappingService.transformText()` on all LLM outputs
4. **Update version** - Increment version when making significant changes
5. **Document variables** - Comment what each variable does in the template
