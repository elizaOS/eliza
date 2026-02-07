/**
 * Pre-built Component Registry for AI App Builder
 *
 * Documents all available Eliza Cloud components that Claude can use
 * WITHOUT writing from scratch. This dramatically reduces AI coding time.
 *
 * Components are written to the sandbox template and referenced in prompts.
 */

export interface PropDefinition {
  name: string;
  type: string;
  required: boolean;
  default?: string;
  description: string;
}

export interface ComponentDefinition {
  name: string;
  path: string; // Import path in sandbox
  description: string;
  props: PropDefinition[];
  example: string;
  dependencies?: string[]; // npm packages needed (already installed)
  relatedComponents?: string[];
  category: ComponentCategory;
}

export type ComponentCategory =
  | "auth"
  | "chat"
  | "billing"
  | "agents"
  | "media"
  | "layout"
  | "forms"
  | "data-display";

/**
 * Pre-built Eliza Cloud Components
 *
 * These components are automatically available in the sandbox template.
 * Claude should IMPORT and USE these rather than building from scratch.
 */
export const ELIZA_COMPONENTS: Record<string, ComponentDefinition> = {
  // ============================================================================
  // AUTH COMPONENTS
  // ============================================================================
  ElizaAuthProvider: {
    name: "ElizaAuthProvider",
    path: "@/components/eliza/auth/auth-provider",
    category: "auth",
    description:
      "Root auth provider that wraps the app. Already included in layout.tsx.",
    props: [
      {
        name: "children",
        type: "React.ReactNode",
        required: true,
        description: "Child components",
      },
    ],
    example: `// Already in layout.tsx - no need to add
<ElizaAuthProvider>
  {children}
</ElizaAuthProvider>`,
  },

  LoginButton: {
    name: "LoginButton",
    path: "@/components/eliza/auth/login-button",
    category: "auth",
    description:
      "Pre-styled login button with multiple variants. Handles auth flow automatically.",
    props: [
      {
        name: "variant",
        type: '"default" | "outline" | "ghost"',
        required: false,
        default: "default",
        description: "Button style variant",
      },
      {
        name: "size",
        type: '"sm" | "md" | "lg"',
        required: false,
        default: "md",
        description: "Button size",
      },
      {
        name: "onSuccess",
        type: "() => void",
        required: false,
        description: "Callback after successful login",
      },
      {
        name: "className",
        type: "string",
        required: false,
        description: "Additional CSS classes",
      },
    ],
    example: `import { LoginButton } from '@/components/eliza/auth/login-button';

<LoginButton 
  variant="default" 
  onSuccess={() => router.push('/dashboard')} 
/>`,
    relatedComponents: ["UserProfile", "ProtectedRoute"],
  },

  UserProfile: {
    name: "UserProfile",
    path: "@/components/eliza/auth/user-profile",
    category: "auth",
    description:
      "Displays user avatar, name, and dropdown menu with logout option.",
    props: [
      {
        name: "showCredits",
        type: "boolean",
        required: false,
        default: "true",
        description: "Show credit balance in dropdown",
      },
      {
        name: "onLogout",
        type: "() => void",
        required: false,
        description: "Callback after logout",
      },
    ],
    example: `import { UserProfile } from '@/components/eliza/auth/user-profile';

<UserProfile showCredits onLogout={() => router.push('/')} />`,
    relatedComponents: ["LoginButton", "CreditBalance"],
  },

  ProtectedRoute: {
    name: "ProtectedRoute",
    path: "@/components/eliza/auth/protected-route",
    category: "auth",
    description:
      "Wrapper that redirects unauthenticated users. Use for protected pages.",
    props: [
      {
        name: "children",
        type: "React.ReactNode",
        required: true,
        description: "Protected content",
      },
      {
        name: "redirectTo",
        type: "string",
        required: false,
        default: "/",
        description: "Redirect path for unauthenticated users",
      },
      {
        name: "loadingComponent",
        type: "React.ReactNode",
        required: false,
        description: "Custom loading component",
      },
    ],
    example: `import { ProtectedRoute } from '@/components/eliza/auth/protected-route';

export default function DashboardPage() {
  return (
    <ProtectedRoute redirectTo="/login">
      <DashboardContent />
    </ProtectedRoute>
  );
}`,
    relatedComponents: ["LoginButton", "UserProfile"],
  },

  // ============================================================================
  // CHAT COMPONENTS
  // ============================================================================
  StreamingChat: {
    name: "StreamingChat",
    path: "@/components/eliza/chat/streaming-chat",
    category: "chat",
    description:
      "Full-featured chat interface with streaming responses, markdown rendering, and code blocks.",
    props: [
      {
        name: "model",
        type: "string",
        required: false,
        default: "gpt-4o",
        description: "AI model to use",
      },
      {
        name: "systemPrompt",
        type: "string",
        required: false,
        description: "System prompt for the AI",
      },
      {
        name: "placeholder",
        type: "string",
        required: false,
        default: "Type a message...",
        description: "Input placeholder text",
      },
      {
        name: "className",
        type: "string",
        required: false,
        description: "Additional CSS classes",
      },
      {
        name: "welcomeMessage",
        type: "string",
        required: false,
        description: "Initial message shown to user",
      },
    ],
    example: `import { StreamingChat } from '@/components/eliza/chat/streaming-chat';

<StreamingChat 
  model="gpt-4o" 
  systemPrompt="You are a helpful assistant" 
  welcomeMessage="Hello! How can I help you today?"
/>`,
    relatedComponents: ["MessageList", "MessageInput"],
  },

  MessageList: {
    name: "MessageList",
    path: "@/components/eliza/chat/message-list",
    category: "chat",
    description:
      "Scrollable message list with auto-scroll. Renders user and assistant messages.",
    props: [
      {
        name: "messages",
        type: "Message[]",
        required: true,
        description: "Array of messages to display",
      },
      {
        name: "loading",
        type: "boolean",
        required: false,
        description: "Show loading indicator for streaming",
      },
    ],
    example: `import { MessageList } from '@/components/eliza/chat/message-list';

<MessageList 
  messages={messages} 
  loading={isStreaming} 
/>`,
    relatedComponents: ["StreamingChat", "MessageInput"],
  },

  MessageInput: {
    name: "MessageInput",
    path: "@/components/eliza/chat/message-input",
    category: "chat",
    description: "Chat input with send button. Supports Enter to send.",
    props: [
      {
        name: "onSend",
        type: "(message: string) => void",
        required: true,
        description: "Callback when message is sent",
      },
      {
        name: "disabled",
        type: "boolean",
        required: false,
        description: "Disable input while processing",
      },
      {
        name: "placeholder",
        type: "string",
        required: false,
        default: "Type a message...",
        description: "Placeholder text",
      },
    ],
    example: `import { MessageInput } from '@/components/eliza/chat/message-input';

<MessageInput 
  onSend={handleSend} 
  disabled={loading} 
/>`,
    relatedComponents: ["StreamingChat", "MessageList"],
  },

  // ============================================================================
  // BILLING COMPONENTS
  // ============================================================================
  CreditBalance: {
    name: "CreditBalance",
    path: "@/components/eliza/billing/credit-balance",
    category: "billing",
    description:
      "Displays current credit balance with auto-refresh. Optional top-up button.",
    props: [
      {
        name: "showTopUp",
        type: "boolean",
        required: false,
        default: "true",
        description: "Show top-up button",
      },
      {
        name: "refreshInterval",
        type: "number",
        required: false,
        default: "30000",
        description: "Auto-refresh interval in ms",
      },
      {
        name: "compact",
        type: "boolean",
        required: false,
        description: "Compact display mode",
      },
    ],
    example: `import { CreditBalance } from '@/components/eliza/billing/credit-balance';

<CreditBalance showTopUp refreshInterval={30000} />`,
    relatedComponents: ["UsageChart", "PricingTable"],
  },

  UsageChart: {
    name: "UsageChart",
    path: "@/components/eliza/billing/usage-chart",
    category: "billing",
    description: "Chart showing credit usage over time. Uses recharts.",
    props: [
      {
        name: "period",
        type: '"7d" | "30d" | "90d"',
        required: false,
        default: "30d",
        description: "Time period to display",
      },
      {
        name: "height",
        type: "number",
        required: false,
        default: "300",
        description: "Chart height in pixels",
      },
    ],
    example: `import { UsageChart } from '@/components/eliza/billing/usage-chart';

<UsageChart period="30d" height={300} />`,
    dependencies: ["recharts"],
    relatedComponents: ["CreditBalance"],
  },

  PricingTable: {
    name: "PricingTable",
    path: "@/components/eliza/billing/pricing-table",
    category: "billing",
    description: "Displays API pricing for different features.",
    props: [
      {
        name: "features",
        type: "string[]",
        required: false,
        description: "Filter to specific features",
      },
    ],
    example: `import { PricingTable } from '@/components/eliza/billing/pricing-table';

<PricingTable features={['chat', 'image', 'video']} />`,
    relatedComponents: ["CreditBalance"],
  },

  // ============================================================================
  // AGENT COMPONENTS
  // ============================================================================
  AgentCard: {
    name: "AgentCard",
    path: "@/components/eliza/agents/agent-card",
    category: "agents",
    description:
      "Card displaying agent info with avatar, name, bio, and action buttons.",
    props: [
      {
        name: "agent",
        type: "{ id: string; name: string; bio: string; avatar?: string }",
        required: true,
        description: "Agent data",
      },
      {
        name: "onChat",
        type: "(agentId: string) => void",
        required: false,
        description: "Callback when chat button clicked",
      },
      {
        name: "onSelect",
        type: "(agentId: string) => void",
        required: false,
        description: "Callback when card is selected",
      },
    ],
    example: `import { AgentCard } from '@/components/eliza/agents/agent-card';

<AgentCard 
  agent={{ id: '123', name: 'Helper', bio: 'Your assistant' }}
  onChat={(id) => router.push(\`/chat/\${id}\`)}
/>`,
    relatedComponents: ["AgentList", "AgentChat"],
  },

  AgentList: {
    name: "AgentList",
    path: "@/components/eliza/agents/agent-list",
    category: "agents",
    description:
      "Grid of agent cards. Fetches agents automatically using listAgents().",
    props: [
      {
        name: "onSelectAgent",
        type: "(agentId: string) => void",
        required: false,
        description: "Callback when agent is selected",
      },
      {
        name: "columns",
        type: "number",
        required: false,
        default: "3",
        description: "Number of grid columns",
      },
    ],
    example: `import { AgentList } from '@/components/eliza/agents/agent-list';

<AgentList 
  onSelectAgent={(id) => setSelectedAgent(id)} 
  columns={3}
/>`,
    relatedComponents: ["AgentCard", "AgentChat"],
  },

  AgentChat: {
    name: "AgentChat",
    path: "@/components/eliza/agents/agent-chat",
    category: "agents",
    description:
      "Chat interface for a specific agent. Uses chatWithAgent() API.",
    props: [
      {
        name: "agentId",
        type: "string",
        required: true,
        description: "ID of the agent to chat with",
      },
      {
        name: "agentName",
        type: "string",
        required: false,
        description: "Display name of the agent",
      },
      {
        name: "onBack",
        type: "() => void",
        required: false,
        description: "Callback for back button",
      },
    ],
    example: `import { AgentChat } from '@/components/eliza/agents/agent-chat';

<AgentChat 
  agentId="agent-123" 
  agentName="Helper"
  onBack={() => router.back()}
/>`,
    relatedComponents: ["AgentCard", "AgentList"],
  },

  // ============================================================================
  // MEDIA COMPONENTS
  // ============================================================================
  ImageGenerator: {
    name: "ImageGenerator",
    path: "@/components/eliza/media/image-generator",
    category: "media",
    description: "Image generation interface with prompt input and gallery.",
    props: [
      {
        name: "defaultPrompt",
        type: "string",
        required: false,
        description: "Pre-filled prompt",
      },
      {
        name: "onGenerate",
        type: "(url: string) => void",
        required: false,
        description: "Callback with generated image URL",
      },
      {
        name: "showGallery",
        type: "boolean",
        required: false,
        default: "true",
        description: "Show recent generations",
      },
    ],
    example: `import { ImageGenerator } from '@/components/eliza/media/image-generator';

<ImageGenerator 
  onGenerate={(url) => setGeneratedImage(url)}
  showGallery
/>`,
    relatedComponents: ["VideoGenerator"],
  },

  VideoGenerator: {
    name: "VideoGenerator",
    path: "@/components/eliza/media/video-generator",
    category: "media",
    description: "Video generation interface with prompt and preview.",
    props: [
      {
        name: "defaultPrompt",
        type: "string",
        required: false,
        description: "Pre-filled prompt",
      },
      {
        name: "onGenerate",
        type: "(url: string) => void",
        required: false,
        description: "Callback with generated video URL",
      },
    ],
    example: `import { VideoGenerator } from '@/components/eliza/media/video-generator';

<VideoGenerator onGenerate={(url) => console.log(url)} />`,
    relatedComponents: ["ImageGenerator"],
  },

  // ============================================================================
  // LAYOUT COMPONENTS
  // ============================================================================
  DashboardLayout: {
    name: "DashboardLayout",
    path: "@/components/eliza/layout/dashboard-layout",
    category: "layout",
    description:
      "Complete dashboard layout with sidebar, header, and main content area.",
    props: [
      {
        name: "children",
        type: "React.ReactNode",
        required: true,
        description: "Main content",
      },
      {
        name: "sidebarItems",
        type: "NavItem[]",
        required: false,
        description: "Custom sidebar navigation items",
      },
      {
        name: "title",
        type: "string",
        required: false,
        description: "Page title shown in header",
      },
    ],
    example: `import { DashboardLayout } from '@/components/eliza/layout/dashboard-layout';

export default function DashboardPage() {
  return (
    <DashboardLayout title="Dashboard">
      <YourContent />
    </DashboardLayout>
  );
}`,
    relatedComponents: ["Sidebar", "Header"],
  },

  Sidebar: {
    name: "Sidebar",
    path: "@/components/eliza/layout/sidebar",
    category: "layout",
    description: "Collapsible sidebar with navigation items and user profile.",
    props: [
      {
        name: "items",
        type: "NavItem[]",
        required: true,
        description: "Navigation items",
      },
      {
        name: "collapsed",
        type: "boolean",
        required: false,
        description: "Collapsed state",
      },
      {
        name: "onToggle",
        type: "() => void",
        required: false,
        description: "Toggle collapse callback",
      },
    ],
    example: `import { Sidebar } from '@/components/eliza/layout/sidebar';

const items = [
  { label: 'Home', href: '/', icon: Home },
  { label: 'Chat', href: '/chat', icon: MessageSquare },
];

<Sidebar items={items} />`,
    relatedComponents: ["DashboardLayout", "Header"],
  },

  Header: {
    name: "Header",
    path: "@/components/eliza/layout/header",
    category: "layout",
    description: "App header with logo, navigation, and user profile.",
    props: [
      {
        name: "title",
        type: "string",
        required: false,
        description: "Page title",
      },
      {
        name: "showCredits",
        type: "boolean",
        required: false,
        default: "true",
        description: "Show credit balance",
      },
    ],
    example: `import { Header } from '@/components/eliza/layout/header';

<Header title="My App" showCredits />`,
    relatedComponents: ["DashboardLayout", "Sidebar", "UserProfile"],
  },
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get all components by category
 */
export function getComponentsByCategory(
  category: ComponentCategory,
): ComponentDefinition[] {
  return Object.values(ELIZA_COMPONENTS).filter((c) => c.category === category);
}

/**
 * Get all available categories
 */
export function getCategories(): ComponentCategory[] {
  const categories = new Set(
    Object.values(ELIZA_COMPONENTS).map((c) => c.category),
  );
  return Array.from(categories);
}

/**
 * Search components by name or description
 */
export function searchComponents(query: string): ComponentDefinition[] {
  const lowerQuery = query.toLowerCase();
  return Object.values(ELIZA_COMPONENTS).filter(
    (c) =>
      c.name.toLowerCase().includes(lowerQuery) ||
      c.description.toLowerCase().includes(lowerQuery),
  );
}

/**
 * Generate prompt-friendly component catalog
 */
export function generateComponentCatalog(
  categories?: ComponentCategory[],
): string {
  const components = categories
    ? Object.values(ELIZA_COMPONENTS).filter((c) =>
        categories.includes(c.category),
      )
    : Object.values(ELIZA_COMPONENTS);

  const grouped = components.reduce(
    (acc, component) => {
      if (!acc[component.category]) acc[component.category] = [];
      acc[component.category].push(component);
      return acc;
    },
    {} as Record<string, ComponentDefinition[]>,
  );

  let catalog = `## Pre-Built Eliza Components\n\n`;
  catalog += `**IMPORTANT:** Use these pre-built components instead of building from scratch.\n\n`;

  for (const [category, comps] of Object.entries(grouped)) {
    catalog += `### ${category.charAt(0).toUpperCase() + category.slice(1)} Components\n\n`;

    for (const comp of comps) {
      catalog += `#### ${comp.name}\n`;
      catalog += `\`import { ${comp.name} } from '${comp.path}';\`\n\n`;
      catalog += `${comp.description}\n\n`;
      catalog += `**Props:**\n`;
      for (const prop of comp.props) {
        const required = prop.required ? "(required)" : "(optional)";
        const defaultVal = prop.default ? ` = ${prop.default}` : "";
        catalog += `- \`${prop.name}: ${prop.type}\` ${required}${defaultVal} - ${prop.description}\n`;
      }
      catalog += `\n**Example:**\n\`\`\`tsx\n${comp.example}\n\`\`\`\n\n`;
    }
  }

  return catalog;
}

/**
 * Generate compact component reference for prompts
 */
export function generateCompactCatalog(): string {
  let catalog = `## Available Components (USE THESE - Don't rebuild!)\n\n`;

  const byCategory = Object.values(ELIZA_COMPONENTS).reduce(
    (acc, c) => {
      if (!acc[c.category]) acc[c.category] = [];
      acc[c.category].push(c);
      return acc;
    },
    {} as Record<string, ComponentDefinition[]>,
  );

  for (const [cat, comps] of Object.entries(byCategory)) {
    catalog += `**${cat}:** `;
    catalog += comps.map((c) => `\`${c.name}\``).join(", ");
    catalog += `\n`;
  }

  catalog += `\n### Quick Import Examples:\n`;
  catalog += `\`\`\`tsx
// Auth
import { LoginButton, UserProfile, ProtectedRoute } from '@/components/eliza/auth';

// Chat
import { StreamingChat, MessageList, MessageInput } from '@/components/eliza/chat';

// Billing  
import { CreditBalance, UsageChart } from '@/components/eliza/billing';

// Agents
import { AgentCard, AgentList, AgentChat } from '@/components/eliza/agents';

// Layout
import { DashboardLayout, Sidebar, Header } from '@/components/eliza/layout';

// Media
import { ImageGenerator, VideoGenerator } from '@/components/eliza/media';
\`\`\`\n`;

  return catalog;
}
