/**
 * Template-Specific Prompts
 *
 * Concise guidance for each app template type.
 * Each template includes a minimal complete example.
 */

export type TemplateType =
  | "chat"
  | "agent-dashboard"
  | "landing-page"
  | "analytics"
  | "saas-starter"
  | "ai-tool"
  | "mcp-service"
  | "a2a-agent"
  | "blank";

export const TEMPLATE_PROMPTS: Record<TemplateType, string> = {
  chat: `## Chat App

Build a conversational AI interface with:
- Message list (user/assistant)
- Input with send button
- Streaming responses

**Minimum files needed:**
1. \`src/components/ChatMessage.tsx\` - Single message component
2. \`src/components/ChatInput.tsx\` - Input with send button
3. \`src/app/page.tsx\` - **RENDERS THE CHAT UI**

**Quick example for page.tsx:**
\`\`\`tsx
'use client';
import { useState } from 'react';
import { useChatStream } from '@/hooks/use-eliza';

export default function ChatPage() {
  const [messages, setMessages] = useState<{role: string; content: string}[]>([]);
  const [input, setInput] = useState('');
  const { stream, loading } = useChatStream();

  const handleSend = async () => {
    if (!input.trim()) return;
    const userMsg = { role: 'user', content: input };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    
    let response = '';
    setMessages(prev => [...prev, { role: 'assistant', content: '' }]);
    
    for await (const chunk of stream([...messages, userMsg])) {
      const text = chunk.choices?.[0]?.delta?.content || '';
      response += text;
      setMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'assistant', content: response };
        return updated;
      });
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gray-950">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'text-right' : ''}>
            <div className={\`inline-block p-3 rounded-lg \${m.role === 'user' ? 'bg-orange-600' : 'bg-gray-800'}\`}>
              {m.content || '...'}
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
            placeholder="Type a message..."
            className="flex-1 p-3 bg-gray-800 rounded-lg"
          />
          <button onClick={handleSend} disabled={loading} className="px-6 py-3 bg-orange-600 rounded-lg">
            {loading ? '...' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
\`\`\`
`,

  "agent-dashboard": `## Agent Dashboard

Build an agent management interface:
- Agent cards grid
- Chat with agents
- Status indicators

**Key imports:**
\`\`\`tsx
import { useAgents, useAgentChat } from '@/hooks/use-eliza';
\`\`\`

**page.tsx must render agent list and chat functionality.**
`,

  "landing-page": `## Landing Page

Build a marketing/landing page:
- Hero section
- Features grid
- CTA buttons
- Footer

No SDK needed for static pages. **page.tsx must render the landing page.**
`,

  analytics: `## Analytics Dashboard

Build a data visualization dashboard:
- KPI cards
- Charts (install recharts)
- Data tables

**page.tsx must render the dashboard with actual data.**
`,

  "saas-starter": `## SaaS Starter

Build a complete SaaS app:

**Key components:**
\`\`\`tsx
import { ProtectedRoute, SignInButton, UserMenu, AppCreditDisplay } from "@elizaos/cloud-ui";
\`\`\`

**page.tsx must render a landing page or dashboard based on auth state.**
`,

  "ai-tool": `## AI Tool

Build a focused single-purpose AI tool:
- Landing with pricing
- Sign in for access  
- Main tool interface
- Credit display

**page.tsx must render the tool interface.**
`,

  "mcp-service": `## MCP Service
Build an MCP server. Advanced template.
`,

  "a2a-agent": `## A2A Agent
Build an A2A endpoint. Advanced template.
`,

  blank: `## Custom App
Build what the user requests. **page.tsx MUST render the UI.**
`,
};

export const TEMPLATE_EXAMPLES: Record<TemplateType, string[]> = {
  chat: [
    "Add sidebar with conversation history",
    "Add markdown rendering",
    "Add typing indicator",
    "Add image upload support",
  ],
  "agent-dashboard": [
    "Add agent cards grid",
    "Create agent chat modal",
    "Add analytics charts",
    "Show conversation logs",
  ],
  "landing-page": [
    "Create hero with gradient",
    "Add features section",
    "Create pricing table",
    "Add contact form",
  ],
  analytics: ["Add KPI cards", "Create trend chart", "Add date picker", "Add data export"],
  "saas-starter": [
    "Create dashboard layout",
    "Add billing page",
    "Add settings page",
    "Create API playground",
  ],
  "ai-tool": [
    "Create image generator",
    "Build text summarizer",
    "Make code assistant",
    "Create writing helper",
  ],
  "mcp-service": [
    "Create tool handler",
    "Add resource provider",
    "Implement search",
    "Add prompts",
  ],
  "a2a-agent": ["Create agent card", "Add task handler", "Add discovery", "Create router"],
  blank: ["Create dashboard", "Add navigation", "Create data table", "Add theme toggle"],
};
