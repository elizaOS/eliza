/**
 * Knowledge Context Builder for AI App Builder
 *
 * Aggregates context for AI models to build Eliza Cloud apps.
 * Documents the ACTUAL files in cloud-apps-template.
 *
 * Supports tiered context loading to optimize token usage.
 * Works with any AI model via AI SDK and AI Gateway.
 */

import { buildApiContext } from "@/lib/fragments/api-context";
import type { ComponentCategory } from "./component-registry";

// ============================================================================
// TYPES
// ============================================================================

export type ContextTier = "minimal" | "standard" | "comprehensive";

export interface KnowledgeContextConfig {
  tier?: ContextTier;
  templateType?: string;
  includeApis?: string[];
  includeComponents?: ComponentCategory[];
  includePatterns?: PatternType[];
  customInstructions?: string;
}

export interface KnowledgeContext {
  tier: ContextTier;
  sdkReference: string;
  componentCatalog: string;
  apiReference: string;
  patterns: string;
  constraints: string;
  estimatedTokens: number;
}

export type PatternType =
  | "streaming-chat"
  | "agent-chat"
  | "agent-dedicated-chat"
  | "image-generation"
  | "credits-display"
  | "dashboard-layout"
  | "data-fetching"
  | "form-handling"
  | "user-auth"
  | "protected-route"
  | "user-credits"
  | "credit-purchase";

// ============================================================================
// TIER CONFIGURATIONS
// ============================================================================

const TIER_CONFIG: Record<
  ContextTier,
  {
    tokens: number;
    includes: {
      sdk: "compact" | "full";
      components: "compact" | "full" | "none";
      apis: "none" | "essential" | "full";
      patterns: "none" | "common" | "all";
    };
  }
> = {
  minimal: {
    tokens: 2500,
    includes: {
      sdk: "compact",
      components: "compact",
      apis: "none",
      patterns: "none",
    },
  },
  standard: {
    tokens: 8000,
    includes: {
      sdk: "full",
      components: "compact",
      apis: "essential",
      patterns: "common",
    },
  },
  comprehensive: {
    tokens: 20000,
    includes: {
      sdk: "full",
      components: "full",
      apis: "full",
      patterns: "all",
    },
  },
};

// ============================================================================
// CONSTRAINTS - What NOT to do
// ============================================================================

const CONSTRAINTS = `
## CRITICAL CONSTRAINTS - NEVER DO THESE:

### Files That Are Pre-Built (DO NOT recreate):
- \`@/lib/eliza.ts\` - SDK is pre-configured with all API functions
- \`@/hooks/use-eliza.ts\` - React hooks are pre-built
- \`@/components/eliza/\` - Provider and utilities are ready to use

### CRITICAL: ElizaProvider and Analytics in layout.tsx
**NEVER remove ElizaProvider from layout.tsx!** Without it, all Eliza hooks will fail.
**ALWAYS include Analytics** for dashboard metrics on deployed apps.
When writing layout.tsx, you MUST include:
\`\`\`tsx
import { ElizaProvider } from '@/components/eliza';
import { Analytics } from '@vercel/analytics/next';

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <ElizaProvider>{children}</ElizaProvider>
        <Analytics />
      </body>
    </html>
  );
}
\`\`\`

### API Key Handling:
- **DO NOT** create API key input fields, forms, or configuration screens
- **DO NOT** ask users to "enter your API key" or "set ELIZA_API_KEY"
- **DO NOT** create settings pages for API credentials
- The API key is automatically injected via \`NEXT_PUBLIC_ELIZA_API_KEY\`

### Styling:
- **DO NOT** use Tailwind v3 syntax (@tailwind base/components/utilities)
- **USE** Tailwind v4 syntax: \`@import "tailwindcss";\` in globals.css
- **USE** standard Tailwind classes: \`bg-gray-900\`, \`text-white\`, etc.
- **USE** utility classes in globals.css: \`.btn-eliza\`, \`.card-eliza\`, \`.input-eliza\`

### Architecture:
- **DO NOT** build custom API clients (use \`@/lib/eliza\`)
- **DO NOT** build custom streaming logic (use \`useChatStream\` hook)
- **DO NOT** implement credit checking manually (use \`useElizaCredits\` hook)
- **ALWAYS** keep \`ElizaProvider\` wrapping children in layout.tsx

### Client vs Server Components:
- **ADD \`'use client'\` at the top of files that use:**
  - React hooks: useState, useEffect, useRef, useContext, useCallback
  - Eliza hooks: useChat, useChatStream, useEliza, useElizaCredits
  - Event handlers: onClick, onChange, onSubmit
  - Browser APIs: window, document, localStorage
- **Server Components (default) CANNOT use hooks or event handlers**
- **Forgetting 'use client' causes "useState is not a function" errors**

### Authentication (User Sign-in):
- **Auth pages are pre-built** - don't recreate them!
  - \`/auth/callback/page.tsx\` - OAuth callback handler
  - \`/billing/success/page.tsx\` - Purchase success page
- **USE pre-built components** from '@/components/eliza':
  - \`SignInButton\` - Redirects to Eliza Cloud login
  - \`SignOutButton\` - Signs out user
  - \`UserMenu\` - Dropdown with user info and sign out
  - \`ProtectedRoute\` - Wraps content requiring authentication
- **USE \`useElizaAuth\` hook** for auth state (user, isAuthenticated, loading)
- **DO NOT** build custom OAuth flows

### User Credits (App-specific):
- Each user has their **own credit balance per app** (not shared with org)
- **USE \`useAppCredits\`** hook for user's app credits (balance, purchase, hasLowBalance)
- **DO NOT** confuse with \`useElizaCredits\` which is for org-level credits
- **USE pre-built components** for credits:
  - \`AppCreditDisplay\` - Shows user's balance
  - \`AppLowBalanceWarning\` - Warning banner when low
  - \`PurchaseCreditsButton\` - Opens Stripe checkout
  - \`PurchaseCreditsModal\` - Modal with amount selection
  - \`CreditBalanceCard\` - Full card with balance and purchase
- SDK automatically bills user's credits when they're authenticated

### ABSOLUTELY FORBIDDEN - NO MOCKS/DEMOS/PLACEHOLDERS:
- **NEVER** create fake, mock, demo, or simulated AI responses
- **NEVER** use placeholder arrays like \`demoResponses = ["Hello!", "I'm demo..."]\`
- **NEVER** use \`setTimeout\` to fake API delays
- **NEVER** write "demo", "mock", "placeholder", "simulated" in comments
- **ALWAYS** call the REAL SDK functions - they work!
- The SDK connects to REAL Eliza Cloud servers with REAL AI
- There is ZERO reason to mock anything - the SDK is production-ready
`;

// ============================================================================
// SDK REFERENCE - Documents actual @/lib/eliza.ts
// ============================================================================

const SDK_REFERENCE_FULL = `
## Eliza Cloud SDK - \`@/lib/eliza.ts\` (PRE-BUILT)

The SDK is pre-configured. Just import and use:

\`\`\`typescript
import { 
  chat, 
  chatStream, 
  generateImage, 
  generateVideo,
  listAgents, 
  chatWithAgent, 
  uploadFile, 
  getBalance,
  trackPageView 
} from '@/lib/eliza';
\`\`\`

### AI Chat

\`\`\`typescript
// Non-streaming
const response = await chat([
  { role: 'user', content: 'Hello!' }
], 'gpt-4o');
console.log(response.choices[0].message.content);

// Streaming (async generator)
for await (const chunk of chatStream([{ role: 'user', content: 'Hello!' }])) {
  const content = chunk.choices?.[0]?.delta?.content;
  if (content) process.stdout.write(content);
}
\`\`\`

### Image Generation

\`\`\`typescript
const result = await generateImage('A sunset over mountains', {
  model: 'dall-e-3',
  width: 1024,
  height: 1024
});
// Access the image URL:
const imageUrl = result.images?.[0]?.url || result.url;
\`\`\`

### Video Generation

\`\`\`typescript
const { url, id } = await generateVideo('A timelapse of clouds', {
  duration: 5
});
\`\`\`

### AI Agents

\`\`\`typescript
// List available agents
const agents = await listAgents();

// Get a specific agent
const agent = await getAgent('agent-id');
console.log(agent.name, agent.description);

// Chat with an agent (maintains conversation via roomId)
let roomId: string | undefined;
const { text, roomId: newRoomId } = await chatWithAgent(
  'agent-id',
  'Hello!',
  roomId
);
roomId = newRoomId; // Save for continued conversation

// Streaming agent chat
for await (const chunk of chatWithAgentStream('agent-id', 'Hello!', roomId)) {
  console.log(chunk.text);
}
\`\`\`

### File Upload

\`\`\`typescript
const { url, filename, size, mimeType } = await uploadFile(file, 'document.pdf');
console.log('Uploaded to:', url);
\`\`\`

### Credits

\`\`\`typescript
const { balance } = await getBalance();
if (balance < 10) console.warn('Low credits!');
\`\`\`

## React Hooks - \`@/hooks/use-eliza.ts\` (PRE-BUILT)

\`\`\`typescript
import {
  useChat,
  useChatStream,
  useImageGeneration,
  useVideoGeneration,
  useAgents,         // List agents + chatWith helper
  useAgentChat,      // Full chat interface for a specific agent
  useCredits,
  useFileUpload,
  usePageTracking
} from '@/hooks/use-eliza';
\`\`\`

### useChat - Non-streaming chat

\`\`\`typescript
const { send, loading, error, reset } = useChat();

const handleSend = async () => {
  const response = await send([{ role: 'user', content: input }]);
  if (response) {
    setOutput(response.choices[0].message.content);
  }
};
\`\`\`

### useChatStream - Streaming responses

\`\`\`typescript
const { stream, loading, error } = useChatStream();
const [content, setContent] = useState('');

const handleStream = async () => {
  setContent('');
  for await (const chunk of stream([{ role: 'user', content: input }])) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) setContent(prev => prev + delta);
  }
};
\`\`\`

### useImageGeneration

\`\`\`typescript
const { generate, loading, error, result, reset } = useImageGeneration();

await generate('A beautiful landscape');
// Access image: result?.images?.[0]?.url
\`\`\`

### useAgents - List and chat with agents

\`\`\`typescript
const { agents, loading, error, chatWith } = useAgents();

// agents is auto-fetched on mount
const response = await chatWith(agents[0].id, 'Hello!');
console.log(response.text);
// Conversation state is tracked automatically per agent
\`\`\`

### useAgentChat - Full chat interface for a specific agent

\`\`\`typescript
// Best for building dedicated character chat interfaces
const { 
  agent,        // Agent info (name, avatar, description)
  messages,     // Array of { role, content }
  loading, 
  error, 
  send,         // Send a message
  sendStream,   // Send with streaming response
  reset         // Clear conversation
} = useAgentChat('agent-id');

// Send a message - messages array updates automatically
await send('Hello!');

// Streaming
for await (const chunk of sendStream('Tell me a story')) {
  console.log(chunk); // Real-time text
}
\`\`\`

### useCredits - Balance management

\`\`\`typescript
const { balance, loading, error, refresh } = useCredits(30000); // auto-refresh every 30s

if (balance !== null && balance < 10) {
  showLowBalanceWarning();
}
\`\`\`

### useFileUpload

\`\`\`typescript
const { upload, loading, error, uploadedUrl, reset } = useFileUpload();

const handleUpload = async (file: File) => {
  const url = await upload(file);
  console.log('Uploaded to:', url);
};
\`\`\`
`;

const SDK_REFERENCE_COMPACT = `
## Eliza SDK (PRE-BUILT - DO NOT RECREATE)

### Functions (\`@/lib/eliza\`):
- \`chat(messages, model?)\` - AI chat completion
- \`chatStream(messages, model?)\` - Streaming chat (async generator)
- \`generateImage(prompt, options?)\` - Image generation
- \`generateVideo(prompt, options?)\` - Video generation
- \`listAgents()\` - List AI agents
- \`chatWithAgent(agentId, message, roomId?)\` - Agent chat
- \`uploadFile(file, filename)\` - File upload
- \`getBalance()\` - Get credit balance

### Hooks (\`@/hooks/use-eliza\`):
- \`useChat()\` - { send, loading, error }
- \`useChatStream()\` - { stream, loading, error }
- \`useImageGeneration()\` - { generate, loading, result, reset }
- \`useVideoGeneration()\` - { generate, loading, videoUrl }
- \`useAgents()\` - { agents, loading, chatWith } - list agents & quick chat
- \`useAgentChat(agentId)\` - { agent, messages, send, sendStream, reset } - full chat UI
- \`useCredits(interval?)\` - { balance, loading, refresh }
- \`useFileUpload()\` - { upload, loading, uploadedUrl }
`;

// ============================================================================
// COMPONENT REFERENCE - Documents actual @/components/eliza/
// ============================================================================

const COMPONENT_REFERENCE_FULL = `
## Eliza Components - \`@/components/eliza/\` (PRE-BUILT)

### ElizaProvider
Wraps your app with analytics and credits context. Already in \`layout.tsx\`.

\`\`\`typescript
import { ElizaProvider } from '@/components/eliza';

// In layout.tsx (already configured):
<ElizaProvider 
  creditsRefreshInterval={60000}  // Auto-refresh credits
  lowBalanceThreshold={10}        // Warn below this
  disableAnalytics={false}        // Page tracking
>
  {children}
</ElizaProvider>
\`\`\`

### useEliza - Access full context

\`\`\`typescript
import { useEliza } from '@/components/eliza';

const { credits, appId, isReady } = useEliza();
\`\`\`

### useElizaCredits - Credits management

\`\`\`typescript
import { useElizaCredits } from '@/components/eliza';

const { balance, loading, error, refresh, hasLowBalance } = useElizaCredits();

if (hasLowBalance) {
  // Show warning
}
\`\`\`

### CreditDisplay - Show balance

\`\`\`typescript
import { CreditDisplay } from '@/components/eliza';

// In your header or sidebar:
<CreditDisplay showWarning className="text-sm" />
\`\`\`

### LowBalanceWarning - Warning banner

\`\`\`typescript
import { LowBalanceWarning } from '@/components/eliza';

// Shows automatically when balance is low:
<LowBalanceWarning 
  message="Your credits are running low."
/>
\`\`\`

## Utility CSS Classes (in globals.css)

- \`.btn-eliza\` - Primary orange button
- \`.btn-eliza-outline\` - Outlined button
- \`.card-eliza\` - Dark card with border
- \`.input-eliza\` - Text input field
- \`.prose-eliza\` - Markdown/prose styling
- \`.animate-fade-in\` - Fade in animation
- \`.animate-slide-up\` - Slide up animation

---

## Authentication Components (for user sign-in)

### SignInButton
\`\`\`typescript
import { SignInButton } from '@/components/eliza';

<SignInButton />  // Redirects to Eliza Cloud login
<SignInButton variant="outline" size="lg" />
\`\`\`

### UserMenu
\`\`\`typescript
import { UserMenu } from '@/components/eliza';

<UserMenu />  // Dropdown with avatar, name, sign out
\`\`\`

### ProtectedRoute
\`\`\`typescript
import { ProtectedRoute } from '@/components/eliza';

<ProtectedRoute>
  <Dashboard />  {/* Shows login prompt if not authenticated */}
</ProtectedRoute>
\`\`\`

### useElizaAuth Hook
\`\`\`typescript
import { useElizaAuth } from '@/components/eliza';

const { user, isAuthenticated, loading, signIn, signOut } = useElizaAuth();
\`\`\`

---

## User App Credits (user-specific billing)

Each user has their OWN credit balance per app. Use these instead of org-level credits.

### useAppCredits Hook
\`\`\`typescript
import { useAppCredits } from '@/components/eliza';

const { balance, hasLowBalance, purchase, refresh } = useAppCredits();

// purchase(50) opens Stripe checkout for $50
\`\`\`

### AppCreditDisplay
\`\`\`typescript
import { AppCreditDisplay } from '@/components/eliza';

<AppCreditDisplay showRefresh />
\`\`\`

### PurchaseCreditsButton
\`\`\`typescript
import { PurchaseCreditsButton } from '@/components/eliza';

<PurchaseCreditsButton amount={50} />  // Opens Stripe checkout
\`\`\`

### CreditBalanceCard
\`\`\`typescript
import { CreditBalanceCard } from '@/components/eliza';

<CreditBalanceCard />  // Full card with balance and purchase button
\`\`\`
`;

const COMPONENT_REFERENCE_COMPACT = `
## Eliza Components (PRE-BUILT)

### From \`@/components/eliza\`:
- \`ElizaProvider\` - Wrap app (already in layout.tsx)
- \`useEliza()\` - { credits, appId, isReady }
- \`useElizaCredits()\` - { balance, loading, hasLowBalance, refresh } (org-level)
- \`CreditDisplay\` - Show org balance inline
- \`LowBalanceWarning\` - Warning banner (org-level)

### Auth Components:
- \`SignInButton\` - Login with Eliza Cloud
- \`SignOutButton\` - Sign out
- \`UserMenu\` - User dropdown with sign out
- \`ProtectedRoute\` - Wrap content requiring auth
- \`useElizaAuth()\` - { user, isAuthenticated, loading, signIn, signOut }

### User App Credits (user has own balance):
- \`useAppCredits()\` - { balance, hasLowBalance, purchase, refresh }
- \`AppCreditDisplay\` - Show user's balance
- \`AppLowBalanceWarning\` - Warning when user's balance is low
- \`PurchaseCreditsButton\` - Opens Stripe checkout
- \`CreditBalanceCard\` - Full balance card with purchase

### CSS Utilities (globals.css):
- \`.btn-eliza\` - Primary button
- \`.btn-eliza-outline\` - Outlined button
- \`.card-eliza\` - Card container
- \`.input-eliza\` - Text input
`;

// ============================================================================
// PATTERNS - Real code examples using actual template
// ============================================================================

const PATTERNS: Record<PatternType, { description: string; code: string }> = {
  "streaming-chat": {
    description: "Streaming chat with AI",
    code: `'use client';
import { useState } from 'react';
import { useChatStream } from '@/hooks/use-eliza';
import { Send, Loader2 } from 'lucide-react';

type Message = { role: 'user' | 'assistant'; content: string };

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const { stream, loading } = useChatStream();

  const handleSend = async () => {
    if (!input.trim() || loading) return;

    const userMsg: Message = { role: 'user', content: input };
    setMessages(prev => [...prev, userMsg]);
    setInput('');

    // Add empty assistant message for streaming
    setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

    for await (const chunk of stream([...messages, userMsg])) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1].content += delta;
          return updated;
        });
      }
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gray-950">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((m, i) => (
          <div key={i} className={\`flex \${m.role === 'user' ? 'justify-end' : 'justify-start'}\`}>
            <div className={\`max-w-[80%] p-3 rounded-lg \${
              m.role === 'user' 
                ? 'bg-eliza-orange text-white' 
                : 'bg-gray-800 text-gray-200'
            }\`}>
              {m.content || <Loader2 className="h-4 w-4 animate-spin" />}
            </div>
          </div>
        ))}
      </div>
      <div className="p-4 border-t border-gray-800">
        <div className="flex gap-2 max-w-4xl mx-auto">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSend()}
            placeholder="Type a message..."
            className="input-eliza flex-1"
            disabled={loading}
          />
          <button onClick={handleSend} disabled={loading} className="btn-eliza">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}`,
  },

  "agent-chat": {
    description: "Chat with AI agents",
    code: `'use client';
import { useState } from 'react';
import { useAgents } from '@/hooks/use-eliza';
import { Bot, ArrowLeft, Send, Loader2 } from 'lucide-react';

export default function AgentsPage() {
  const { agents, loading, error, chatWith } = useAgents();
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Array<{ role: string; content: string }>>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    if (!input.trim() || !selected || sending) return;
    
    setSending(true);
    setMessages(prev => [...prev, { role: 'user', content: input }]);
    setInput('');
    
    const result = await chatWith(selected, input);
    if (result) {
      setMessages(prev => [...prev, { role: 'assistant', content: result.text }]);
    }
    setSending(false);
  };

  if (loading) return <div className="p-8 text-gray-400">Loading agents...</div>;
  if (error) return <div className="p-8 text-red-400">{error}</div>;

  if (selected) {
    const agent = agents.find(a => a.id === selected);
    return (
      <div className="flex flex-col h-screen">
        <header className="p-4 border-b border-gray-800 flex items-center gap-3">
          <button onClick={() => { setSelected(null); setMessages([]); }} className="btn-eliza-outline p-2">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <Bot className="h-5 w-5 text-eliza-orange" />
          <span className="font-medium">{agent?.name}</span>
        </header>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.map((m, i) => (
            <div key={i} className={\`\${m.role === 'user' ? 'text-right' : ''}\`}>
              <div className={\`inline-block p-3 rounded-lg \${
                m.role === 'user' ? 'bg-eliza-orange' : 'bg-gray-800'
              }\`}>
                {m.content}
              </div>
            </div>
          ))}
        </div>
        <div className="p-4 border-t border-gray-800">
          <div className="flex gap-2">
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSend()}
              className="input-eliza flex-1"
              placeholder="Message agent..."
            />
            <button onClick={handleSend} disabled={sending} className="btn-eliza">
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-6">Choose an Agent</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map(agent => (
          <button
            key={agent.id}
            onClick={() => setSelected(agent.id)}
            className="card-eliza text-left hover:border-eliza-orange transition-colors"
          >
            <Bot className="h-8 w-8 text-eliza-orange mb-3" />
            <h3 className="font-medium text-lg">{agent.name}</h3>
            <p className="text-sm text-gray-400 mt-1">{agent.bio}</p>
          </button>
        ))}
      </div>
    </div>
  );
}`,
  },

  "agent-dedicated-chat": {
    description: "Chat interface for a specific AI agent",
    code: `'use client';
import { useAgentChat } from '@/hooks/use-eliza';
import { Send, Loader2, Bot, RotateCcw } from 'lucide-react';
import { useState } from 'react';

// Pass the agent ID as a prop or from URL params
export default function AgentChat({ agentId }: { agentId: string }) {
  const { agent, agentLoading, messages, loading, error, send, reset } = useAgentChat(agentId);
  const [input, setInput] = useState('');

  const handleSend = async () => {
    if (!input.trim() || loading) return;
    const message = input;
    setInput('');
    await send(message);
  };

  if (agentLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-eliza-orange" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-gray-950">
      {/* Header with agent info */}
      <header className="p-4 border-b border-gray-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {agent?.avatar ? (
            <img src={agent.avatar} alt={agent.name} className="h-10 w-10 rounded-full" />
          ) : (
            <div className="h-10 w-10 rounded-full bg-eliza-orange/20 flex items-center justify-center">
              <Bot className="h-5 w-5 text-eliza-orange" />
            </div>
          )}
          <div>
            <h1 className="font-semibold">{agent?.name || 'AI Agent'}</h1>
            {agent?.description && (
              <p className="text-sm text-gray-400 line-clamp-1">{agent.description}</p>
            )}
          </div>
        </div>
        <button onClick={reset} className="p-2 rounded-lg hover:bg-gray-800 text-gray-400" title="Start new conversation">
          <RotateCcw className="h-5 w-5" />
        </button>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-gray-500 py-12">
            <Bot className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>Start chatting with {agent?.name || 'the agent'}!</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={\`flex \${m.role === 'user' ? 'justify-end' : 'justify-start'}\`}>
            <div className={\`max-w-[80%] p-3 rounded-2xl \${
              m.role === 'user' 
                ? 'bg-eliza-orange text-white rounded-br-md' 
                : 'bg-gray-800 text-gray-100 rounded-bl-md'
            }\`}>
              {m.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-gray-800 rounded-2xl rounded-bl-md p-3">
              <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
            </div>
          </div>
        )}
      </div>

      {/* Error display */}
      {error && (
        <div className="px-4 py-2 bg-red-500/10 border-t border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Input */}
      <div className="p-4 border-t border-gray-800">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
            placeholder={\`Message \${agent?.name || 'agent'}...\`}
            className="input-eliza flex-1"
            disabled={loading}
          />
          <button 
            onClick={handleSend} 
            disabled={loading || !input.trim()}
            className="btn-eliza px-4"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}`,
  },

  "image-generation": {
    description: "Generate images with AI",
    code: `'use client';
import { useState } from 'react';
import { useImageGeneration } from '@/hooks/use-eliza';
import { ImageIcon, Loader2, Download } from 'lucide-react';

export default function ImagePage() {
  const [prompt, setPrompt] = useState('');
  const { generate, loading, error, imageUrl, reset } = useImageGeneration();
  const [history, setHistory] = useState<string[]>([]);

  const handleGenerate = async () => {
    if (!prompt.trim() || loading) return;
    
    const url = await generate(prompt);
    if (url) {
      setHistory(prev => [url, ...prev]);
      setPrompt('');
    }
  };

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Image Generator</h1>
      
      <div className="card-eliza mb-6">
        <div className="flex gap-3">
          <input
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleGenerate()}
            placeholder="Describe the image you want to create..."
            className="input-eliza flex-1"
            disabled={loading}
          />
          <button onClick={handleGenerate} disabled={loading} className="btn-eliza">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
            Generate
          </button>
        </div>
        
        {error && (
          <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
            {error}
          </div>
        )}

        {imageUrl && (
          <div className="mt-4 relative group">
            <img src={imageUrl} alt="Generated" className="w-full rounded-lg" />
            <a
              href={imageUrl}
              download
              className="absolute top-2 right-2 p-2 bg-gray-900/80 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <Download className="h-4 w-4" />
            </a>
          </div>
        )}
      </div>

      {history.length > 0 && (
        <div>
          <h2 className="text-lg font-medium mb-4">History</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {history.map((url, i) => (
              <img key={i} src={url} alt="" className="rounded-lg aspect-square object-cover" />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}`,
  },

  "credits-display": {
    description: "Display and manage credits",
    code: `'use client';
import { useElizaCredits, CreditDisplay, LowBalanceWarning } from '@/components/eliza';
import { RefreshCw, TrendingUp, TrendingDown } from 'lucide-react';

export default function BillingPage() {
  const { balance, loading, refresh, hasLowBalance } = useElizaCredits();

  return (
    <div className="p-8 max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">Billing & Credits</h1>
      
      <LowBalanceWarning />
      
      <div className="card-eliza">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-medium">Current Balance</h2>
          <button 
            onClick={refresh} 
            disabled={loading}
            className="btn-eliza-outline p-2"
          >
            <RefreshCw className={\`h-4 w-4 \${loading ? 'animate-spin' : ''}\`} />
          </button>
        </div>
        
        <div className="text-4xl font-bold text-eliza-orange">
          {balance !== null ? balance.toLocaleString() : '—'}
          <span className="text-lg font-normal text-gray-400 ml-2">credits</span>
        </div>
        
        {hasLowBalance && (
          <div className="mt-4 flex items-center gap-2 text-amber-400 text-sm">
            <TrendingDown className="h-4 w-4" />
            Running low - consider topping up
          </div>
        )}
      </div>

      <div className="card-eliza">
        <h2 className="text-lg font-medium mb-4">Pricing Reference</h2>
        <div className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-400">Chat (GPT-4o)</span>
            <span>~0.01 credits/message</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Image Generation</span>
            <span>~0.50 credits/image</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Video Generation</span>
            <span>~5.00 credits/video</span>
          </div>
        </div>
      </div>
    </div>
  );
}`,
  },

  "dashboard-layout": {
    description: "Dashboard with navigation",
    code: `'use client';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CreditDisplay } from '@/components/eliza';
import { 
  Home, MessageSquare, Image, Settings, 
  Menu, X, Sparkles 
} from 'lucide-react';

const navItems = [
  { href: '/dashboard', label: 'Home', icon: Home },
  { href: '/dashboard/chat', label: 'Chat', icon: MessageSquare },
  { href: '/dashboard/images', label: 'Images', icon: Image },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className={\`
        fixed inset-y-0 left-0 z-50 w-64 bg-gray-900 border-r border-gray-800
        transform transition-transform lg:translate-x-0 lg:static
        \${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
      \`}>
        <div className="flex items-center gap-3 p-4 border-b border-gray-800">
          <Sparkles className="h-6 w-6 text-eliza-orange" />
          <span className="font-semibold">My App</span>
        </div>
        
        <nav className="p-4 space-y-1">
          {navItems.map(item => (
            <Link
              key={item.href}
              href={item.href}
              className={\`
                flex items-center gap-3 px-3 py-2 rounded-lg transition-colors
                \${pathname === item.href 
                  ? 'bg-eliza-orange/10 text-eliza-orange' 
                  : 'text-gray-400 hover:text-white hover:bg-gray-800'}
              \`}
            >
              <item.icon className="h-5 w-5" />
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center justify-between p-4 border-b border-gray-800">
          <button 
            onClick={() => setSidebarOpen(true)}
            className="lg:hidden btn-eliza-outline p-2"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex-1" />
          <CreditDisplay />
        </header>
        
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}`,
  },

  "data-fetching": {
    description: "Fetch and display data",
    code: `'use client';
import { useAgents, useCredits } from '@/hooks/use-eliza';
import { useElizaCredits } from '@/components/eliza';
import { Bot, Coins, RefreshCw } from 'lucide-react';

export default function DashboardHome() {
  const { agents, loading: agentsLoading } = useAgents();
  const { balance, loading: creditsLoading, refresh } = useElizaCredits();

  return (
    <div className="p-8 space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Credits Card */}
        <div className="card-eliza">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Coins className="h-5 w-5 text-eliza-orange" />
              <h2 className="font-medium">Credits</h2>
            </div>
            <button onClick={refresh} disabled={creditsLoading} className="text-gray-400 hover:text-white">
              <RefreshCw className={\`h-4 w-4 \${creditsLoading ? 'animate-spin' : ''}\`} />
            </button>
          </div>
          <p className="text-3xl font-bold">
            {creditsLoading ? '...' : balance?.toLocaleString() ?? '—'}
          </p>
        </div>

        {/* Agents Card */}
        <div className="card-eliza">
          <div className="flex items-center gap-2 mb-4">
            <Bot className="h-5 w-5 text-eliza-orange" />
            <h2 className="font-medium">Available Agents</h2>
          </div>
          <p className="text-3xl font-bold">
            {agentsLoading ? '...' : agents.length}
          </p>
        </div>
      </div>

      {/* Agents List */}
      {!agentsLoading && agents.length > 0 && (
        <div>
          <h2 className="text-lg font-medium mb-4">Your Agents</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {agents.map(agent => (
              <div key={agent.id} className="card-eliza">
                <Bot className="h-6 w-6 text-eliza-orange mb-2" />
                <h3 className="font-medium">{agent.name}</h3>
                <p className="text-sm text-gray-400 mt-1">{agent.bio}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}`,
  },

  "form-handling": {
    description: "Form with AI processing",
    code: `'use client';
import { useState } from 'react';
import { useChat } from '@/hooks/use-eliza';
import { Loader2, Send } from 'lucide-react';

export default function AIFormPage() {
  const [name, setName] = useState('');
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState('');
  const { send, loading, error } = useChat();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim() || loading) return;

    const response = await send([
      { role: 'system', content: \`The user's name is \${name || 'Anonymous'}. Be helpful and friendly.\` },
      { role: 'user', content: question }
    ]);

    if (response?.choices?.[0]?.message?.content) {
      setResult(response.choices[0].message.content);
    }
  };

  return (
    <div className="p-8 max-w-lg mx-auto">
      <h1 className="text-2xl font-bold mb-6">Ask AI</h1>
      
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-400 mb-2">
            Your Name (optional)
          </label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="John"
            className="input-eliza"
          />
        </div>
        
        <div>
          <label className="block text-sm font-medium text-gray-400 mb-2">
            Your Question
          </label>
          <textarea
            value={question}
            onChange={e => setQuestion(e.target.value)}
            placeholder="What would you like to know?"
            rows={4}
            className="input-eliza resize-none"
            required
          />
        </div>

        <button 
          type="submit" 
          disabled={loading || !question.trim()} 
          className="btn-eliza w-full"
        >
          {loading ? (
            <><Loader2 className="h-4 w-4 animate-spin" /> Processing...</>
          ) : (
            <><Send className="h-4 w-4" /> Ask AI</>
          )}
        </button>
      </form>

      {error && (
        <div className="mt-4 p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-6 card-eliza animate-fade-in">
          <h2 className="text-sm font-medium text-gray-400 mb-2">Response</h2>
          <div className="prose-eliza">
            {result}
          </div>
        </div>
      )}
    </div>
  );
}`,
  },

  "user-auth": {
    description: "User authentication with sign in/out",
    code: `'use client';
import { useElizaAuth, SignInButton, SignOutButton, UserMenu } from '@/components/eliza';

export function Header() {
  const { user, isAuthenticated, loading } = useElizaAuth();

  return (
    <header className="flex items-center justify-between p-4 border-b border-gray-800">
      <h1 className="text-xl font-bold">My App</h1>
      
      <div className="flex items-center gap-4">
        {loading ? (
          <div className="h-8 w-8 rounded-full bg-gray-700 animate-pulse" />
        ) : isAuthenticated ? (
          <UserMenu />
        ) : (
          <SignInButton />
        )}
      </div>
    </header>
  );
}`,
  },

  "protected-route": {
    description: "Protect pages that require authentication",
    code: `'use client';
import { ProtectedRoute, UserMenu, AppCreditDisplay } from '@/components/eliza';
import Link from 'next/link';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <ProtectedRoute>
      <div className="flex h-screen">
        {/* Sidebar */}
        <aside className="w-64 border-r border-gray-800 flex flex-col">
          <div className="p-4 border-b border-gray-800">
            <h1 className="font-bold text-eliza-orange">Dashboard</h1>
          </div>
          <nav className="flex-1 p-4 space-y-1">
            <Link href="/dashboard" className="block px-3 py-2 rounded-lg hover:bg-gray-800">
              Home
            </Link>
            <Link href="/dashboard/settings" className="block px-3 py-2 rounded-lg hover:bg-gray-800">
              Settings
            </Link>
          </nav>
          <div className="p-4 border-t border-gray-800 space-y-3">
            <AppCreditDisplay showRefresh />
            <UserMenu />
          </div>
        </aside>
        
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </ProtectedRoute>
  );
}`,
  },

  "user-credits": {
    description: "Display and manage user's app credits",
    code: `'use client';
import { useAppCredits, AppCreditDisplay, AppLowBalanceWarning, CreditBalanceCard } from '@/components/eliza';
import { Loader2 } from 'lucide-react';

export default function BillingPage() {
  const { balance, totalSpent, loading, hasLowBalance, refresh } = useAppCredits();

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-8 w-8 animate-spin text-eliza-orange" />
      </div>
    );
  }

  return (
    <div className="p-8 max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">Billing & Credits</h1>
      
      {/* Low balance warning */}
      <AppLowBalanceWarning />
      
      {/* Credit balance card with purchase button */}
      <CreditBalanceCard />
      
      {/* Usage stats */}
      <div className="card-eliza">
        <h2 className="text-lg font-medium mb-4">Usage Summary</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-sm text-gray-400">Current Balance</p>
            <p className="text-2xl font-bold text-eliza-orange">\${balance.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-sm text-gray-400">Total Spent</p>
            <p className="text-2xl font-bold">\${totalSpent.toFixed(2)}</p>
          </div>
        </div>
      </div>
    </div>
  );
}`,
  },

  "credit-purchase": {
    description: "Credit purchase flow with modal",
    code: `'use client';
import { useState } from 'react';
import { useAppCredits, PurchaseCreditsModal, PurchaseCreditsButton } from '@/components/eliza';
import { Plus, CreditCard } from 'lucide-react';

export function PurchaseSection() {
  const { balance } = useAppCredits();
  const [showModal, setShowModal] = useState(false);

  return (
    <div className="card-eliza">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-medium">Purchase Credits</h3>
          <p className="text-sm text-gray-400">Current balance: \${balance.toFixed(2)}</p>
        </div>
        <CreditCard className="h-6 w-6 text-eliza-orange" />
      </div>
      
      {/* Quick purchase options */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <PurchaseCreditsButton amount={10} variant="outline">$10</PurchaseCreditsButton>
        <PurchaseCreditsButton amount={25} variant="outline">$25</PurchaseCreditsButton>
        <PurchaseCreditsButton amount={50} variant="outline">$50</PurchaseCreditsButton>
      </div>
      
      {/* Or open full modal */}
      <button 
        onClick={() => setShowModal(true)}
        className="w-full btn-eliza-outline justify-center"
      >
        <Plus className="h-4 w-4" />
        Choose amount
      </button>
      
      <PurchaseCreditsModal 
        open={showModal} 
        onClose={() => setShowModal(false)}
        presets={[5, 10, 25, 50, 100]}
      />
    </div>
  );
}`,
  },
};

// ============================================================================
// CONTEXT BUILDER
// ============================================================================

/**
 * Build knowledge context for AI App Builder
 */
export async function buildKnowledgeContext(
  config: KnowledgeContextConfig = {},
): Promise<KnowledgeContext> {
  const tier = config.tier || "standard";
  const tierConfig = TIER_CONFIG[tier];

  // SDK Reference
  const sdkReference =
    tierConfig.includes.sdk === "compact"
      ? SDK_REFERENCE_COMPACT
      : SDK_REFERENCE_FULL;

  // Component Catalog
  let componentCatalog = "";
  if (tierConfig.includes.components === "full") {
    componentCatalog = COMPONENT_REFERENCE_FULL;
  } else if (tierConfig.includes.components === "compact") {
    componentCatalog = COMPONENT_REFERENCE_COMPACT;
  }

  // API Reference
  let apiReference = "";
  if (tierConfig.includes.apis === "essential") {
    apiReference = await buildApiContext({
      categories: ["AI Completions", "Image Generation"],
      limit: 10,
      includeExamples: false,
    });
  } else if (tierConfig.includes.apis === "full") {
    apiReference = await buildApiContext({
      categories: config.includeApis,
      limit: 30,
      includeExamples: true,
    });
  }

  // Patterns
  let patterns = "";
  const patternTypes = config.includePatterns || getDefaultPatterns(tierConfig);
  if (patternTypes.length > 0) {
    patterns = buildPatternsSection(patternTypes);
  }

  // Estimate tokens (rough: 1 token ≈ 4 chars)
  const totalChars =
    sdkReference.length +
    componentCatalog.length +
    apiReference.length +
    patterns.length +
    CONSTRAINTS.length;
  const estimatedTokens = Math.ceil(totalChars / 4);

  return {
    tier,
    sdkReference,
    componentCatalog,
    apiReference,
    patterns,
    constraints: CONSTRAINTS,
    estimatedTokens,
  };
}

function getDefaultPatterns(
  tierConfig: (typeof TIER_CONFIG)[ContextTier],
): PatternType[] {
  if (tierConfig.includes.patterns === "none") return [];
  if (tierConfig.includes.patterns === "common") {
    return ["streaming-chat", "credits-display", "dashboard-layout"];
  }
  return Object.keys(PATTERNS) as PatternType[];
}

function buildPatternsSection(patternTypes: PatternType[]): string {
  let section = `## Code Patterns\n\n`;
  section += `Copy these patterns for implementing features:\n\n`;

  for (const type of patternTypes) {
    const pattern = PATTERNS[type];
    if (pattern) {
      section += `### ${type
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ")}\n`;
      section += `${pattern.description}\n\n`;
      section += `\`\`\`tsx\n${pattern.code}\n\`\`\`\n\n`;
    }
  }

  return section;
}

/**
 * Build complete system prompt with knowledge context
 */
export async function buildSystemPromptWithContext(config: {
  templateType?: string;
  tier?: ContextTier;
  includeApis?: string[];
  includeComponents?: ComponentCategory[];
  includePatterns?: PatternType[];
  customInstructions?: string;
}): Promise<string> {
  const context = await buildKnowledgeContext(config);

  let prompt = `You are an expert Next.js developer building production apps on Eliza Cloud.

## Tech Stack
- Next.js 16 (App Router, src/app/)
- TypeScript, React 19
- Tailwind CSS 4 (standard classes only)

## CRITICAL: Tailwind CSS v4 Setup
The globals.css uses Tailwind v4 syntax:
\`\`\`css
@import "tailwindcss";
\`\`\`

${context.constraints}

${context.sdkReference}

${context.componentCatalog}

${context.patterns}

${context.apiReference}

## UI Guidelines
- Dark theme: bg-gray-900/950, text-white
- Eliza orange: Use \`eliza-orange\` CSS variable or #FF5800
- Use utility classes: \`.btn-eliza\`, \`.card-eliza\`, \`.input-eliza\`
- Mobile-first responsive design

## Workflow - WRITE FILES PROGRESSIVELY
**CRITICAL:** Write each file IMMEDIATELY when ready. Users see live updates!

1. Write layout.tsx FIRST with UNIQUE metadata (creative title, not "My App")
2. Write page.tsx EARLY - even a basic version, then iterate
3. Write each component ONE BY ONE as you build
4. Do NOT batch files - do NOT save page.tsx for last
5. Use pre-built hooks (\`@/hooks/use-eliza\`) for all API calls
6. Run \`bun run build\` before completing to catch TypeScript errors

## NEVER Break the Build
- Do NOT import files that don't exist yet!
- Write dependencies BEFORE files that import them
- Example: Write header.tsx BEFORE page.tsx that imports it
- Each file write should result in a working build
- Do NOT check_build after every file - HMR auto-refreshes!
- Only run check_build ONCE at the very end

## UNIQUE Metadata - REQUIRED
\`\`\`tsx
export const metadata: Metadata = {
  title: 'Creative Specific Title', // NOT "My App"!
  description: 'Compelling description of this specific app',
  openGraph: { title: 'Creative Title', description: '...', type: 'website' },
};
\`\`\`
`;

  if (config.customInstructions) {
    prompt += `\n## Additional Instructions\n${config.customInstructions}\n`;
  }

  return prompt;
}

/**
 * Smart tier selection based on prompt analysis
 */
export function selectContextTier(
  prompt: string,
  templateType?: string,
): ContextTier {
  const lowerPrompt = prompt.toLowerCase();

  // Keywords that suggest need for comprehensive context
  const complexKeywords = [
    "dashboard",
    "analytics",
    "billing",
    "authentication",
    "multi-page",
    "complete app",
    "full application",
    "integration",
    "agent",
    "chat with",
    "talk to",
    "voice",
    "video",
    "saas",
    "sign in",
    "login",
    "credits",
    "payment",
  ];

  // Keywords that suggest minimal context is sufficient
  const simpleKeywords = [
    "button",
    "style",
    "color",
    "text",
    "fix",
    "change",
    "update",
    "small",
    "simple",
  ];

  const hasComplex = complexKeywords.some((kw) => lowerPrompt.includes(kw));
  const hasSimple = simpleKeywords.some((kw) => lowerPrompt.includes(kw));

  // Template-based defaults
  const complexTemplates = [
    "agent-dashboard",
    "analytics",
    "mcp-service",
    "saas-starter",
    "ai-tool",
  ];
  const isComplexTemplate =
    templateType && complexTemplates.includes(templateType);

  if (isComplexTemplate || (hasComplex && !hasSimple)) {
    return "comprehensive";
  }

  if (hasSimple && !hasComplex) {
    return "minimal";
  }

  return "standard";
}

// Export patterns for external use
export { PATTERNS };
