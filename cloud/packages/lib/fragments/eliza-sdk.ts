/**
 * Eliza SDK Reference (Legacy)
 *
 * Re-exports from the new modular prompt system.
 * New code should import from '@/lib/prompts/sdk' directly.
 */

export {
  SDK_REFERENCE as ELIZA_SDK_REFERENCE,
  SDK_RESTRICTIONS,
} from "@/lib/prompts/sdk";

// Compact version for smaller context
export const ELIZA_SDK_COMPACT = `## Eliza SDK (Pre-built)

### Functions (@/lib/eliza):
- chat, chatStream - AI chat
- generateImage, generateVideo - Media generation
- textToSpeech, listVoices - Voice synthesis
- createEmbeddings - Semantic embeddings
- listAgents, chatWithAgent - Agent interaction
- getAppCharacters, sendCharacterMessage - Character chat
- uploadFile, getBalance, trackPageView

### Hooks (@/hooks/use-eliza):
- useChat, useChatStream
- useImageGeneration, useVideoGeneration
- useTextToSpeech, useEmbeddings
- useAgents, useAgentChat
- useAppCharacters, useCharacterChat
- useFileUpload, useCredits

### Components (@/components/eliza):
- ElizaProvider, SignInButton, UserMenu, ProtectedRoute
- AppCreditDisplay, PurchaseCreditsButton, useAppCredits

**Never recreate SDK files. Never create API key inputs.**
`;

export const ELIZA_INTEGRATION_PROMPT = `## Quick Start

\`\`\`typescript
// API calls
import { chat, generateImage, textToSpeech } from '@/lib/eliza';

// Hooks
import { useChat, useChatStream, useImageGeneration } from '@/hooks/use-eliza';

// Auth & Credits
import { useElizaAuth, useAppCredits, ProtectedRoute } from "@elizaos/cloud-ui";
\`\`\`
`;
