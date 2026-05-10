/**
 * SDK Reference
 *
 * Complete API documentation for the Eliza Cloud SDK.
 * Used by AI to understand available functions and patterns.
 */

export const SDK_REFERENCE = `## Eliza Cloud SDK

The SDK is pre-configured. Import and use directly.

### Core API Functions (@/lib/eliza)

\`\`\`typescript
import { 
  // Chat
  chat,              // Non-streaming chat completion
  chatStream,        // Streaming chat completion
  
  // Generation
  generateImage,     // AI image generation
  generateVideo,     // AI video generation
  
  // Agents
  listAgents,        // List available AI agents
  getAgent,          // Get agent by ID
  chatWithAgent,     // Chat with specific agent
  chatWithAgentStream, // Streaming agent chat
  
  // Characters (app-linked)
  getAppCharacters,         // Get characters for this app
  createCharacterRoom,      // Create chat room with character
  getCharacterRooms,        // Get existing rooms
  sendCharacterMessage,     // Send message to character
  sendCharacterMessageStream, // Stream character response
  
  // Files
  uploadFile,        // Upload file to storage
  
  // Credits
  getBalance,        // Get credit balance
  
  // Analytics
  trackPageView,     // Track page views
} from '@/lib/eliza';
\`\`\`

### React Hooks (@/hooks/use-eliza)

\`\`\`typescript
import {
  // Chat
  useChat,           // { send, loading, error }
  useChatStream,     // { stream, loading }
  
  // Generation
  useImageGeneration, // { generate, loading, result }
  useVideoGeneration, // { generate, loading, videoUrl }
  
  // Agents
  useAgents,         // { agents, chatWith, loading }
  useAgentChat,      // { messages, send, sendStream, agent }
  
  // Characters
  useAppCharacters,   // { characters, loading }
  useCharacterChat,   // { messages, send, sendStream, room }
  useCharacterRooms,  // { rooms, loading }
  
  // Files
  useFileUpload,     // { upload, uploadedUrl, loading }
  
  // Credits
  useCredits,        // { balance, refresh, loading }
  
  // Analytics
  usePageTracking,   // Auto-tracks page views
} from '@/hooks/use-eliza';
\`\`\`

### Auth & Credit Components (@/components/eliza)

\`\`\`typescript
import {
  // Provider (already in layout.tsx)
  ElizaProvider,
  
  // Auth
  SignInButton,        // Redirects to Eliza login
  SignOutButton,       // Signs user out
  UserMenu,            // Avatar + dropdown menu
  ProtectedRoute,      // Wraps protected pages
  AuthStatus,          // Shows auth state
  useElizaAuth,        // { user, isAuthenticated, signIn, signOut }
  
  // Credits (user's app-specific balance)
  AppCreditDisplay,       // Shows balance
  AppLowBalanceWarning,   // Low balance alert
  PurchaseCreditsButton,  // Opens Stripe checkout
  PurchaseCreditsModal,   // Full purchase modal
  CreditBalanceCard,      // Balance with history
  UsageMeter,             // Usage visualization
  useAppCredits,          // { balance, hasLowBalance, purchase }
  
  // Org-level credits (legacy)
  CreditDisplay,
  LowBalanceWarning,
  useElizaCredits,
} from "@elizaos/cloud-ui";
\`\`\`

### Usage Examples

**Streaming Chat:**
\`\`\`tsx
'use client';
import { useChatStream } from '@/hooks/use-eliza';
import { useState } from 'react';

function Chat() {
  const { stream, loading } = useChatStream();
  const [response, setResponse] = useState('');

  const handleSend = async (message: string) => {
    setResponse('');
    for await (const chunk of stream([{ role: 'user', content: message }])) {
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) setResponse(prev => prev + text);
    }
  };
  
  return <div>{response}</div>;
}
\`\`\`

**Image Generation:**
\`\`\`tsx
'use client';
import { useImageGeneration } from '@/hooks/use-eliza';

function ImageGen() {
  const { generate, loading, result } = useImageGeneration();
  
  const handleGenerate = async (prompt: string) => {
    await generate(prompt, { width: 1024, height: 1024 });
  };
  
  return result?.images?.[0]?.url 
    ? <img src={result.images[0].url} alt="Generated" />
    : null;
}
\`\`\`

**Protected Dashboard with Auth:**
\`\`\`tsx
'use client';
import { ProtectedRoute, UserMenu, AppCreditDisplay } from "@elizaos/cloud-ui";

export default function DashboardLayout({ children }) {
  return (
    <ProtectedRoute>
      <header className="flex justify-between p-4">
        <h1>Dashboard</h1>
        <div className="flex gap-4">
          <AppCreditDisplay showRefresh />
          <UserMenu />
        </div>
      </header>
      {children}
    </ProtectedRoute>
  );
}
\`\`\`

**Character Chat:**
\`\`\`tsx
'use client';
import { useCharacterChat } from '@/hooks/use-eliza';

function CharacterChat({ characterId }) {
  const { messages, send, loading } = useCharacterChat(characterId);
  
  return (
    <div>
      {messages.map((m, i) => (
        <div key={i} className={m.role === 'user' ? 'text-right' : ''}>
          {m.content}
        </div>
      ))}
    </div>
  );
}
\`\`\`
`;

export const SDK_RESTRICTIONS = `## SDK Rules

**DO NOT:**
- Create or modify \`@/lib/eliza.ts\` (pre-built)
- Create or modify \`@/hooks/use-eliza.ts\` (pre-built)
- Create or modify \`@/components/eliza/\` (pre-built)
- Remove ElizaProvider from layout.tsx
- Create API key input fields or settings
- Use mock/demo data - USE THE REAL SDK

**The SDK is production-ready. Always use it.**
`;
