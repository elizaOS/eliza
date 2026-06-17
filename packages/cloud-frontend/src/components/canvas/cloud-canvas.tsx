import { STEWARD_SESSION_ENDPOINT } from "@elizaos/shared/steward-session-client";
import { UiRenderer } from "@elizaos/ui/components/config-ui/ui-renderer";
import {
  createElizaGenUiPrefixActionHandler,
  type ElizaGenUiActionHandler,
  ElizaGenUiRenderer,
  officialSpecToEliza,
} from "@elizaos/ui/genui";
import {
  Activity,
  AppWindow,
  BarChart3,
  Bot,
  Check,
  Coins,
  Copy,
  CreditCard,
  Edit3,
  Eye,
  EyeOff,
  FileCode,
  Globe,
  Grid,
  Key,
  Link2,
  Loader2,
  MessageSquare,
  Plug,
  Plus,
  RefreshCw,
  Server,
  Settings,
  Share2,
  Shield,
  Sparkles,
  Terminal,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  User,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { matchPath, useLocation, useNavigate } from "react-router-dom";
import { api } from "@/lib/api-client";
import { type ApiKeyRecord, useApiKeys } from "@/lib/data/api-keys";
import { useAgents } from "@/lib/data/eliza-agents";
import { useSessionAuth, useStewardAuth } from "@/lib/hooks/use-session-auth";
import {
  useCanvasStore,
  type WorkspaceNode,
  type WorkspaceView,
} from "@/lib/stores/canvas-store";
import { useChatStore } from "@/lib/stores/chat-store";
import {
  assessAndGreet,
  processAction,
  processUserMessage,
} from "@/lib/stores/cloud-assistant-agent";
import { useCredits } from "@/providers/CreditsProvider";

const EarningsPage = lazy(() => import("@/dashboard/earnings/Page"));
const AffiliatesPage = lazy(() => import("@/dashboard/affiliates/Page"));
const DocumentsPage = lazy(() => import("@/dashboard/documents/Page"));
const SettingsPage = lazy(() => import("@/dashboard/settings/Page"));
const ApiExplorerPage = lazy(() => import("@/dashboard/api-explorer/Page"));
const AdminPage = lazy(() => import("@/dashboard/admin/Page"));
const AccountPage = lazy(() => import("@/dashboard/account/Page"));
const AppsPage = lazy(() => import("@/dashboard/apps/Page"));

type AgentsQuery = ReturnType<typeof useAgents>;
type ApiKeysQuery = ReturnType<typeof useApiKeys>;

// The canvas UI reads a couple of display fields the agent-list DTO does not
// (yet) carry (`name`, `runtime`); they are optional and currently unpopulated
// by the API, so they render as the existing fallbacks.
type AgentListItem = NonNullable<AgentsQuery["data"]>[number];
type CanvasAgent = AgentListItem & { name?: string; runtime?: string };
// Likewise the keys table reads a plaintext `token` the list DTO omits.
type ApiKeyItem = NonNullable<ApiKeysQuery["data"]>[number];
type CanvasApiKey = ApiKeyItem & { token?: string };

interface ChatMessage {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
}

interface AgentBridgeResponse {
  error?: { message: string } | null;
  result?: {
    text?: string;
    response?: string;
    message?: string;
  } | null;
}

interface InvoiceRecord {
  id: string;
  date?: string;
  total?: string | number;
  status?: string;
  invoicePdf?: string;
  invoiceUrl?: string;
}

interface AuditEventRecord {
  event_id: string;
  action: string;
  result?: string;
  resource?: { type: string; id: string } | null;
  ip?: string | null;
  ts: string;
}

interface SecretRecord {
  id: string;
  name: string;
  provider?: string;
  createdAt?: string;
  description?: string | null;
}

interface McpRecord {
  id?: string;
  name: string;
  slug?: string;
  status?: string;
  description?: string;
  endpointType?: "container" | "external";
  externalEndpoint?: string | null;
  pricingType?: "free" | "credits" | "x402";
  tools?: Array<{ name: string; description: string }>;
}

interface CreateAgentBody {
  agentName: string;
  autoProvision: boolean;
  environmentVars?: Record<string, string>;
  dockerImage?: string;
}

interface ContainerRecord {
  id: string;
  name: string;
  status: string;
  image?: string;
  image_tag?: string;
}

interface DomainRecord {
  id: string;
  domain: string;
  appId?: string | null;
  verified: boolean;
  sslStatus?: string;
}

interface RemoteSessionRecord {
  id: string;
  status: string;
  deviceInfo?: string;
}

interface StreamingTextProps {
  text: string;
  isShort?: boolean;
}

function StreamingText({ text }: StreamingTextProps) {
  const [displayedText, setDisplayedText] = useState("");
  const [isStreaming, setIsStreaming] = useState(true);

  useEffect(() => {
    setDisplayedText("");
    setIsStreaming(true);

    const words = text.split(" ");
    let currentIdx = 0;

    if (words.length === 0 || !text) {
      setIsStreaming(false);
      return;
    }

    const timer = setInterval(() => {
      currentIdx++;
      if (currentIdx >= words.length) {
        setDisplayedText(text);
        setIsStreaming(false);
        clearInterval(timer);
      } else {
        setDisplayedText(words.slice(0, currentIdx + 1).join(" "));
      }
    }, 75);

    return () => {
      clearInterval(timer);
    };
  }, [text]);

  const handleSkip = (e: React.MouseEvent) => {
    if (isStreaming) {
      e.stopPropagation();
      setDisplayedText(text);
      setIsStreaming(false);
    }
  };

  return (
    <span
      onClick={handleSkip}
      className={isStreaming ? "cursor-pointer select-none" : ""}
    >
      {displayedText}
      {isStreaming && (
        <span
          className="inline-block w-1.5 h-4 ml-1 bg-[#FF5800] align-middle animate-pulse"
          style={{
            boxShadow: "0 0 8px rgba(255,88,0,0.8)",
          }}
        />
      )}
    </span>
  );
}

// ── Ambient action titles that float across the background ──
// These are decorative — they hint at what the agent can do via the GenUI chat.
const ACTION_TITLES = [
  "Deploy Agent",
  "Check Billing",
  "View Logs",
  "Monitor Health",
  "API Keys",
  "Scale Instance",
  "Manage Secrets",
  "System Status",
  "Invite Team",
  "Configure Plugins",
  "Analytics",
  "Launch Runtime",
  "Sync State",
  "Deploy Container",
  "Custom Domain",
  "Pair Device",
  "MCP Servers",
  "Publish App",
  "Credit Balance",
  "Connectors",
  "Audit Log",
  "Security",
  "Whitelabel",
  "Container Quota",
];

interface FloatingWord {
  id: number;
  text: string;
  x: number; // percentage
  y: number; // percentage
  size: number; // rem
  duration: number; // seconds
  delay: number; // seconds
  rotation: number; // degrees
}

let wordIdCounter = 0;

function spawnWord(): FloatingWord {
  return {
    id: wordIdCounter++,
    text: ACTION_TITLES[Math.floor(Math.random() * ACTION_TITLES.length)],
    x: 5 + Math.random() * 85,
    y: 8 + Math.random() * 80,
    size: 1.1 + Math.random() * 1.4,
    duration: 6 + Math.random() * 6,
    delay: 0,
    rotation: -8 + Math.random() * 16,
  };
}

function AmbientWords() {
  const [words, setWords] = useState<FloatingWord[]>([]);

  useEffect(() => {
    const initial: FloatingWord[] = [];
    for (let i = 0; i < 5; i++) {
      const w = spawnWord();
      w.delay = i * 1.2;
      initial.push(w);
    }
    setWords(initial);

    const interval = setInterval(
      () => {
        setWords((prev) => {
          const trimmed = prev.length >= 8 ? prev.slice(1) : prev;
          return [...trimmed, spawnWord()];
        });
      },
      2800 + Math.random() * 2000,
    );

    return () => clearInterval(interval);
  }, []);

  return (
    <div
      className="absolute inset-0 overflow-hidden pointer-events-none select-none"
      aria-hidden="true"
    >
      {words.map((w) => (
        <span
          key={w.id}
          className="ambient-word"
          style={{
            left: `${w.x}%`,
            top: `${w.y}%`,
            fontSize: `${w.size}rem`,
            animationDuration: `${w.duration}s`,
            animationDelay: `${w.delay}s`,
            transform: `rotate(${w.rotation}deg)`,
          }}
        >
          {w.text}
        </span>
      ))}
    </div>
  );
}

// Helper: format node name into normal shortened english
function formatNodeTitle(name: string): string {
  if (!name) return "";
  let title = name.replace(/\.view$/, "");
  // Replace snake_case / kebab-case with spaces
  title = title.replace(/[_-]+/g, " ");
  // Capitalize words
  title = title.replace(/\b\w/g, (c) => c.toUpperCase());
  // Shorten common prefix patterns
  title = title
    .replace(
      /^(Show\s+My|Show|View\s+My|View|List\s+My|List|Manage\s+My|Manage|Create\s+My|Create)\s+/i,
      "",
    )
    .trim();
  return title || name;
}

// Map view types to icons
function getViewIcon(type: string) {
  switch (type) {
    case "agents":
      return Bot;
    case "health":
      return Activity;
    case "billing":
      return CreditCard;
    case "apikeys":
      return Key;
    case "analytics":
      return BarChart3;
    case "security":
      return Shield;
    case "connectors":
      return Plug;
    case "mcps":
      return Server;
    case "earnings":
      return Coins;
    case "affiliates":
      return Share2;
    case "documents":
      return FileCode;
    case "settings":
      return Settings;
    case "api-explorer":
      return Terminal;
    case "admin":
      return Shield;
    case "profile":
      return User;
    case "apps":
      return AppWindow;
    case "containers":
      return Server;
    case "domains":
      return Globe;
    case "remotePairing":
      return Link2;
    default:
      return FileCode;
  }
}

// ── Dynamic DNA Loader Component ──
const DNA_ITEMS = [
  { left: "L", right: "W", color: "#00E5FF" },
  { left: "o", right: "a", color: "#2979FF" },
  { left: "a", right: "i", color: "#7C4DFF" },
  { left: "d", right: "t", color: "#FF2BD6" },
  { left: "i", right: "i", color: "#FF3D71" },
  { left: "n", right: "n", color: "#FFB300" },
  { left: "g", right: "g", color: "#B6FF00" },
];

function DnaLoader() {
  return (
    <div className="flex flex-col items-center justify-center p-8 gap-6 w-full h-full min-h-[200px]">
      <div className="dna-container">
        {DNA_ITEMS.map((item, idx) => (
          <div
            key={item.color}
            className="dna-node"
            style={{
              animationDelay: `${idx * 0.12}s`,
            }}
          >
            {/* Left letter (Loading side) */}
            <span
              className="dna-letter dna-letter-left"
              style={{
                animationDelay: `${idx * 0.12}s`,
                color: item.color,
                textShadow: `0 0 10px ${item.color}55`,
              }}
            >
              {item.left}
            </span>

            {/* Connecting line */}
            <span
              className="dna-line"
              style={
                {
                  animationDelay: `${idx * 0.12}s`,
                  background: `linear-gradient(to right, ${item.color}, ${item.color}55, ${item.color})`,
                  "--glow-color": `${item.color}88`,
                } as React.CSSProperties
              }
            />

            {/* Right letter (Waiting side) */}
            <span
              className="dna-letter dna-letter-right"
              style={{
                animationDelay: `${idx * 0.12}s`,
                color: item.color,
                textShadow: `0 0 10px ${item.color}55`,
              }}
            >
              {item.right}
            </span>
          </div>
        ))}
      </div>
      <div className="text-[10px] font-mono tracking-[0.25em] text-white/35 uppercase animate-pulse">
        Synchronizing Node State
      </div>
    </div>
  );
}

// Helper: format credit numbers
const _fmtCredits = (amount: number) => `$${Number(amount).toFixed(2)}`;

function PremiumNodeRenderer({
  node,
  isMaximized,
  runPrompt,
  agentsQuery,
  apiKeysQuery,
  creditBalance,
}: {
  node: WorkspaceNode;
  isMaximized: boolean;
  handleAction: (action: string, params?: Record<string, unknown>) => void;
  runPrompt: (promptText: string) => void;
  agentsQuery: AgentsQuery;
  apiKeysQuery: ApiKeysQuery;
  creditBalance: number | null | undefined;
}) {
  const [activeTab, setActiveTab] = useState("overview");
  const [selectedItem, setSelectedItem] = useState<string | null>(null);

  const location = useLocation();
  const navigate = useNavigate();

  // URL Path to State Sync
  useEffect(() => {
    if (node.type === "agents" && isMaximized) {
      const matchChat = matchPath(
        { path: "/dashboard/agents/:id/chat" },
        location.pathname,
      );
      if (matchChat?.params.id) {
        if (selectedItem !== matchChat.params.id) {
          setSelectedItem(matchChat.params.id);
        }
        if (activeTab !== "chat") {
          setActiveTab("chat");
        }
        return;
      }

      const matchDetail = matchPath(
        { path: "/dashboard/agents/:id" },
        location.pathname,
      );
      if (matchDetail?.params.id) {
        const id = matchDetail.params.id;
        if (id === "deploy") {
          if (selectedItem !== "deploy") {
            setSelectedItem("deploy");
          }
        } else {
          if (selectedItem !== id) {
            setSelectedItem(id);
          }
          if (
            activeTab !== "overview" &&
            activeTab !== "logs" &&
            activeTab !== "settings" &&
            activeTab !== "plugins"
          ) {
            setActiveTab("overview");
          }
        }
      }
    }
  }, [location.pathname, node.type, isMaximized, selectedItem, activeTab]);

  // State to URL Path Sync
  useEffect(() => {
    if (node.type === "agents" && isMaximized && selectedItem) {
      if (selectedItem === "deploy") {
        if (location.pathname !== "/dashboard/agents/deploy") {
          navigate("/dashboard/agents/deploy");
        }
      } else {
        const expectedPath =
          activeTab === "chat"
            ? `/dashboard/agents/${selectedItem}/chat`
            : `/dashboard/agents/${selectedItem}`;
        if (location.pathname !== expectedPath) {
          navigate(expectedPath);
        }
      }
    }
  }, [
    selectedItem,
    activeTab,
    node.type,
    isMaximized,
    navigate,
    location.pathname,
  ]);

  // API Keys editing and import states
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [editingKeyName, setEditingKeyName] = useState("");
  const [quickPasteText, setQuickPasteText] = useState("");
  const [isSavingQuickPaste, setIsSavingQuickPaste] = useState(false);
  const [_generatedPlainKey, setGeneratedPlainKey] = useState<string | null>(
    null,
  );

  // Sub-tab for maximized API keys node
  const [apiKeysSubTab, setApiKeysSubTab] = useState<
    "cloud-keys" | "provider-secrets"
  >("cloud-keys");

  // Agent creation form states
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentFlavor, setNewAgentFlavor] = useState("eliza");
  const [newAgentTier, setNewAgentTier] = useState("shared");
  const [newAgentDockerImage, setNewAgentDockerImage] = useState(
    "ghcr.io/elizaos/eliza:stable",
  );
  const [newAgentEnvVars, setNewAgentEnvVars] = useState<
    Array<{ key: string; value: string }>
  >([
    { key: "OPENAI_API_KEY", value: "" },
    { key: "DISCORD_TOKEN", value: "" },
  ]);
  const [isDeployingAgent, setIsDeployingAgent] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);

  // Minimized agent view creation state
  const [isCreatingAgentMin, setIsCreatingAgentMin] = useState(false);

  // Agent Bridge Chat states
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isSendingChat, setIsSendingChat] = useState(false);
  const [_chatError, setChatError] = useState<string | null>(null);

  useEffect(() => {
    setChatMessages([]);
    setChatError(null);
  }, []);

  // Billing Top Up & Invoices states
  const [rechargeAmount, setRechargeAmount] = useState("50");
  const [isCreatingCheckout, setIsCreatingCheckout] = useState(false);
  const [realInvoices, setRealInvoices] = useState<InvoiceRecord[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);

  // Security audit events states
  const [realAuditLogs, setRealAuditLogs] = useState<AuditEventRecord[]>([]);
  const [loadingAuditLogs, setLoadingAuditLogs] = useState(false);

  // MCP creation & list states
  const [realMcps, setRealMcps] = useState<McpRecord[]>([]);
  const [loadingMcps, setLoadingMcps] = useState(false);
  const [mcpFormName, setMcpFormName] = useState("");
  const [mcpFormSlug, setMcpFormSlug] = useState("");
  const [mcpFormDesc, setMcpFormDesc] = useState("");
  const [mcpFormExternalEndpoint, setMcpFormExternalEndpoint] = useState("");
  const [isCreatingMcp, setIsCreatingMcp] = useState(false);
  const [mcpErrorMsg, setMcpErrorMsg] = useState("");

  const handleStripeCheckout = useCallback(async () => {
    const amt = parseFloat(rechargeAmount);
    if (Number.isNaN(amt) || amt < 1 || amt > 10000) {
      alert("Amount must be between $1 and $10,000");
      return;
    }

    try {
      setIsCreatingCheckout(true);
      const res = await api<{ url: string }>(
        "/api/stripe/create-checkout-session",
        {
          method: "POST",
          json: {
            amount: amt,
            returnUrl: "my-agents",
          },
        },
      );

      if (res?.url) {
        window.location.href = res.url;
      } else {
        throw new Error("No checkout URL returned");
      }
    } catch (e) {
      console.error("Failed to create Stripe session:", e);
      alert(
        e instanceof Error ? e.message : "Failed to create checkout session",
      );
    } finally {
      setIsCreatingCheckout(false);
    }
  }, [rechargeAmount]);

  useEffect(() => {
    if (isMaximized && node.type === "billing") {
      const fetchRealInvoices = async () => {
        try {
          setLoadingInvoices(true);
          const data = await api<{ invoices: InvoiceRecord[] }>(
            "/api/invoices/list",
          );
          if (data && Array.isArray(data.invoices)) {
            setRealInvoices(data.invoices);
          }
        } catch (e) {
          console.error("Failed to load real invoices:", e);
        } finally {
          setLoadingInvoices(false);
        }
      };
      fetchRealInvoices();
    }
  }, [isMaximized, node.type]);

  useEffect(() => {
    if (isMaximized && node.type === "security") {
      const fetchRealAuditLogs = async () => {
        try {
          setLoadingAuditLogs(true);
          const data = await api<{ events: AuditEventRecord[] }>(
            "/api/v1/me/audit-events?limit=50",
          );
          if (data && Array.isArray(data.events)) {
            setRealAuditLogs(data.events);
          }
        } catch (e) {
          console.error("Failed to load real audit logs:", e);
        } finally {
          setLoadingAuditLogs(false);
        }
      };
      fetchRealAuditLogs();
    }
  }, [isMaximized, node.type]);

  const fetchRealMcps = useCallback(async () => {
    try {
      setLoadingMcps(true);
      const data = await api<{ mcps: McpRecord[] }>("/api/v1/mcps?scope=all");
      if (data && Array.isArray(data.mcps)) {
        setRealMcps(data.mcps);
        if (data.mcps.length > 0 && !selectedItem) {
          setSelectedItem(data.mcps[0].id || data.mcps[0].name);
        }
      }
    } catch (e) {
      console.error("Failed to fetch MCPs:", e);
    } finally {
      setLoadingMcps(false);
    }
  }, [selectedItem]);

  useEffect(() => {
    if (isMaximized && node.type === "mcps") {
      fetchRealMcps();
    }
  }, [isMaximized, node.type, fetchRealMcps]);

  const sendAgentMessage = useCallback(
    async (agentId: string) => {
      const text = chatInput.trim();
      if (!text || isSendingChat) return;

      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        text,
      };

      setChatMessages((prev) => [...prev, userMsg]);
      setChatInput("");
      setIsSendingChat(true);
      setChatError(null);

      try {
        const response = await api<AgentBridgeResponse>(
          `/api/v1/eliza/agents/${agentId}/bridge`,
          {
            method: "POST",
            json: {
              jsonrpc: "2.0",
              id: `message.send-${Date.now()}`,
              method: "message.send",
              params: {
                text,
                userId: "dashboard",
                roomId: `dashboard-${agentId}`,
              },
            },
          },
        );

        if (response.error) {
          throw new Error(response.error.message);
        }

        const res = response.result;
        const reply = res?.text || res?.response || res?.message;
        if (!reply) {
          throw new Error("Agent returned an empty response");
        }

        setChatMessages((prev) => [
          ...prev,
          {
            id: `agent-${Date.now()}`,
            role: "agent",
            text: reply,
          },
        ]);
      } catch (err) {
        const errMsg =
          err instanceof Error
            ? err.message
            : "Failed to communicate with agent";
        setChatError(errMsg);
        setChatMessages((prev) => [
          ...prev,
          {
            id: `system-${Date.now()}`,
            role: "system",
            text: errMsg,
          },
        ]);
      } finally {
        setIsSendingChat(false);
      }
    },
    [chatInput, isSendingChat],
  );

  // Interface for external keys
  interface ExternalKeyRecord {
    id: string;
    name: string;
    provider: string;
    value: string;
    is_active: boolean;
    created_at: string;
    description?: string;
  }

  // Load / Seed external keys
  const [externalKeys, setExternalKeys] = useState<ExternalKeyRecord[]>([]);

  // Load secrets from backend on mount
  useEffect(() => {
    let active = true;
    const loadSecrets = async () => {
      try {
        const res = await api<{ secrets: SecretRecord[] }>("/api/v1/secrets");
        if (active && res?.secrets) {
          const mapped: ExternalKeyRecord[] = res.secrets.map((s) => ({
            id: s.id,
            name: s.name,
            provider: s.provider || "custom",
            value: "••••••••••••••••",
            is_active: true,
            created_at: s.createdAt || new Date().toISOString(),
            description: s.description || undefined,
          }));
          setExternalKeys(mapped);
        }
      } catch (e) {
        console.error("Failed to load secrets", e);
      }
    };

    loadSecrets();
    return () => {
      active = false;
    };
  }, []);

  // Form states for external provider secrets
  const [newExtKeyName, setNewExtKeyName] = useState("");
  const [newExtKeyProvider, setNewExtKeyProvider] = useState("openai");
  const [newExtKeyValue, setNewExtKeyValue] = useState("");
  const [newExtKeyDesc, setNewExtKeyDesc] = useState("");

  // Visibility control for external keys
  const [showExtKeyIds, setShowExtKeyIds] = useState<Record<string, boolean>>(
    {},
  );

  // Editing states for external keys
  const [editingExtKeyId, setEditingExtKeyId] = useState<string | null>(null);
  const [editingExtKeyName, setEditingExtKeyName] = useState("");
  const [editingExtKeyProvider, setEditingExtKeyProvider] = useState("openai");
  const [editingExtKeyValue, setEditingExtKeyValue] = useState("");
  const [editingExtKeyDesc, setEditingExtKeyDesc] = useState("");

  const handleQuickSaveKeys = useCallback(async () => {
    if (!quickPasteText.trim()) return;
    setIsSavingQuickPaste(true);
    try {
      const lines = quickPasteText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

      const newExts: ExternalKeyRecord[] = [];

      for (const line of lines) {
        if (line.includes("=")) {
          const idx = line.indexOf("=");
          const name = line.substring(0, idx).trim();
          const valOrScope = line.substring(idx + 1).trim();

          const nameUpper = name.toUpperCase();
          const isKnownScope = [
            "full_admin",
            "admin",
            "full",
            "read_only",
            "read",
            "read_write",
          ].includes(valOrScope.toLowerCase());

          const isSecret =
            !isKnownScope ||
            nameUpper.includes("KEY") ||
            nameUpper.includes("TOKEN") ||
            nameUpper.includes("SECRET") ||
            nameUpper.includes("PASSWORD") ||
            valOrScope.startsWith("sk-") ||
            valOrScope.startsWith("pat_") ||
            valOrScope.length > 20;

          if (isSecret) {
            // Add as external key
            let provider = "custom";
            if (nameUpper.includes("OPENAI")) provider = "openai";
            else if (nameUpper.includes("ANTHROPIC")) provider = "anthropic";
            else if (nameUpper.includes("DISCORD")) provider = "discord";
            else if (nameUpper.includes("TWITTER") || nameUpper.includes("X_"))
              provider = "twitter";
            else if (nameUpper.includes("TELEGRAM")) provider = "telegram";
            else if (nameUpper.includes("ELEVEN")) provider = "elevenlabs";
            else if (nameUpper.includes("FAL")) provider = "fal";

            newExts.push({
              id: `ext-${Math.random().toString(36).substring(2, 11)}`,
              name,
              provider,
              value: valOrScope,
              is_active: true,
              created_at: new Date().toISOString(),
              description: `Pasted via Quick Set`,
            });
          } else {
            const res = await api<{ apiKey: ApiKeyRecord; plainKey: string }>(
              "/api/v1/api-keys",
              {
                method: "POST",
                json: { name },
              },
            );
            if (res?.plainKey) {
              setGeneratedPlainKey(res.plainKey);
            }
          }
        } else {
          const res = await api<{ apiKey: ApiKeyRecord; plainKey: string }>(
            "/api/v1/api-keys",
            {
              method: "POST",
              json: { name: line },
            },
          );
          if (res?.plainKey) {
            setGeneratedPlainKey(res.plainKey);
          }
        }
      }

      if (newExts.length > 0) {
        for (const k of newExts) {
          try {
            const res = await api<{ secret: SecretRecord }>("/api/v1/secrets", {
              method: "POST",
              json: {
                name: k.name,
                provider: k.provider,
                value: k.value,
                description: k.description,
              },
            });
            if (res?.secret) {
              const mapped: ExternalKeyRecord = {
                id: res.secret.id,
                name: res.secret.name,
                provider: res.secret.provider || "custom",
                value: "••••••••••••••••",
                is_active: true,
                created_at: res.secret.createdAt || new Date().toISOString(),
                description: res.secret.description || undefined,
              };
              setExternalKeys((prev) => {
                const existingIdx = prev.findIndex(
                  (x) => x.name === mapped.name,
                );
                if (existingIdx !== -1) {
                  const updated = [...prev];
                  updated[existingIdx] = mapped;
                  return updated;
                }
                return [mapped, ...prev];
              });
            }
          } catch (e) {
            console.error(`Quick save secret error for ${k.name}`, e);
          }
        }
      }

      setQuickPasteText("");
      apiKeysQuery.refetch();
    } catch (e) {
      console.error("quick save error", e);
    } finally {
      setIsSavingQuickPaste(false);
    }
  }, [quickPasteText, apiKeysQuery]);

  // Containers state
  const [containers, setContainers] = useState<ContainerRecord[]>([]);
  const [quota, setQuota] = useState<{
    used: number;
    limit: number;
    creditRunway: number | null;
  }>({ used: 0, limit: 3, creditRunway: null });
  const [newContainerName, setNewContainerName] = useState("");
  const [newImage, setNewImage] = useState("");

  const fetchContainersData = useCallback(async () => {
    try {
      const json = await api<{ success?: boolean; data?: ContainerRecord[] }>(
        "/api/v1/containers",
      );
      if (json?.success && Array.isArray(json.data)) {
        const mapped = json.data.map((c) => ({
          ...c,
          image: c.image || c.image_tag || "",
        }));
        setContainers(mapped);
      }
      const qJson = await api<{
        success?: boolean;
        quota?: { used: number; limit: number; creditRunway: number | null };
      }>("/api/v1/containers/quota");
      if (qJson?.success && qJson.quota) {
        setQuota(qJson.quota);
      }
    } catch (e) {
      console.error("fetchContainersData error", e);
    }
  }, []);

  // Domains state
  const [domains, setDomains] = useState<DomainRecord[]>([]);
  const [newDomainName, setNewDomainName] = useState("");
  const [domainStatusMsg, setDomainStatusMsg] = useState("");

  const fetchDomainsData = useCallback(async () => {
    try {
      const json = await api<{ success?: boolean; domains?: DomainRecord[] }>(
        "/api/v1/domains",
      );
      if (json?.success && Array.isArray(json.domains)) {
        setDomains(json.domains);
      }
    } catch (e) {
      console.error("fetchDomainsData error", e);
    }
  }, []);

  // Remote pairing / sessions state
  const [remoteSessions, setRemoteSessions] = useState<RemoteSessionRecord[]>(
    [],
  );
  const [pairingCode, setPairingCode] = useState("");
  const [pairingExpiry, setPairingExpiry] = useState("");
  const [pairingStatus, setPairingStatus] = useState("idle");
  const [syncStatus, setSyncStatus] = useState("synced");

  const fetchRemoteData = useCallback(async () => {
    try {
      const json = await api<{
        success?: boolean;
        sessions?: RemoteSessionRecord[];
      }>("/api/v1/remote/sessions");
      if (json?.success && Array.isArray(json.sessions)) {
        setRemoteSessions(json.sessions);
      }
    } catch (e) {
      console.error("fetchRemoteData error", e);
    }
  }, []);

  const [earningsBalance, setEarningsBalance] = useState<{
    balance?: {
      totalEarned: number;
      availableBalance: number;
      pendingBalance: number;
      totalRedeemed: number;
      totalPending: number;
      totalConvertedToCredits: number;
    };
  } | null>(null);
  const [, setLoadingEarnings] = useState(false);

  const fetchEarningsData = useCallback(async () => {
    try {
      setLoadingEarnings(true);
      const res = await fetch("/api/v1/redemptions/balance");
      if (res.ok) {
        const data = await res.json();
        setEarningsBalance(data);
      }
    } catch (e) {
      console.error("Failed to load earnings:", e);
    } finally {
      setLoadingEarnings(false);
    }
  }, []);

  const handleGeneratePairingCode = useCallback(async () => {
    setPairingStatus("generating...");
    try {
      const json = await api<{
        success?: boolean;
        code?: string;
        expiresAt?: string;
        data?: { code?: string; expiresAt?: string };
      }>("/api/v1/remote/pair", {
        method: "POST",
      });
      const code = json.code || json.data?.code;
      const expiresAt = json.expiresAt || json.data?.expiresAt;
      if (json.success && code) {
        setPairingCode(code);
        setPairingExpiry(
          expiresAt ? new Date(expiresAt).toLocaleTimeString() : "5 minutes",
        );
        setPairingStatus("active");
      } else {
        setPairingStatus("failed");
      }
    } catch (_e) {
      setPairingStatus("error");
    }
  }, []);

  // Auto-fetch data on mount / tab select
  useEffect(() => {
    if (node.type === "containers") {
      fetchContainersData();
    } else if (node.type === "domains") {
      fetchDomainsData();
    } else if (node.type === "remote" || node.type === "remotePairing") {
      fetchRemoteData();
    } else if (node.type === "earnings") {
      fetchEarningsData();
    }
  }, [
    node.type,
    fetchContainersData,
    fetchDomainsData,
    fetchRemoteData,
    fetchEarningsData,
  ]);

  // local state for forms
  const [envVars, setEnvVars] = useState<Record<string, string>>({
    OPENAI_API_KEY: "sk-proj-••••••••••••••••••••",
    DISCORD_TOKEN: "MTIx••••••••••••••••••••",
    TWITTER_USERNAME: "eliza_agent_01",
  });
  const [showApiKey, setShowApiKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [_mcpConfig, _setMcpConfig] = useState(
    JSON.stringify(
      {
        mcpServers: {
          gdrive: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-gdrive"],
          },
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: {
              GITHUB_PERSONAL_ACCESS_TOKEN: "github_pat_••••••••",
            },
          },
        },
      },
      null,
      2,
    ),
  );

  const [activePlugins, setActivePlugins] = useState<Record<string, boolean>>({
    "web-search": true,
    "image-generation": false,
    coinmarketcap: true,
    "github-mcp": false,
    "postgres-db": true,
    "slack-connector": false,
  });

  const [connectors, setConnectors] = useState<Record<string, boolean>>({
    twitter: false,
    discord: false,
    telegram: false,
    slack: false,
  });

  // Fetch real connector status on mount
  useEffect(() => {
    const platforms = ["discord", "telegram", "twitter"] as const;
    for (const platform of platforms) {
      api<{ connected?: boolean }>(`/api/v1/${platform}/status`)
        .then((res) => {
          if (res && typeof res.connected === "boolean") {
            setConnectors((prev) => ({
              ...prev,
              [platform]: res.connected as boolean,
            }));
          }
        })
        .catch(() => {
          /* ignore — status unknown */
        });
    }
  }, []);

  const [_auditLogs] = useState([
    {
      id: 1,
      action: "API Key Created",
      user: "admin@eliza.cloud",
      ip: "192.168.1.45",
      date: "2026-06-08 00:02",
    },
    {
      id: 2,
      action: "Agent Reconfigured",
      user: "admin@eliza.cloud",
      ip: "192.168.1.45",
      date: "2026-06-07 23:45",
    },
    {
      id: 3,
      action: "SSO Login Success",
      user: "admin@eliza.cloud",
      ip: "192.168.1.45",
      date: "2026-06-07 22:10",
    },
    {
      id: 4,
      action: "MFA Setup Initialized",
      user: "admin@eliza.cloud",
      ip: "192.168.1.45",
      date: "2026-06-07 22:05",
    },
  ]);

  const [transactions] = useState([
    {
      id: "tx_01",
      type: "Deposit",
      desc: "Credit purchase via card",
      amt: 100.0,
      date: "2026-06-07",
    },
    {
      id: "tx_02",
      type: "Usage",
      desc: "Agent Runtime Instance Fee",
      amt: -4.25,
      date: "2026-06-07",
    },
    {
      id: "tx_03",
      type: "Usage",
      desc: "LLM API Proxy Usage",
      amt: -12.18,
      date: "2026-06-06",
    },
    {
      id: "tx_04",
      type: "Deposit",
      desc: "Signup free credits",
      amt: 10.0,
      date: "2026-06-05",
    },
  ]);

  const [_invoices] = useState([
    { id: "INV-2026-001", amt: 100.0, status: "Paid", date: "2026-06-07" },
    { id: "INV-2026-002", amt: 50.0, status: "Paid", date: "2026-05-18" },
  ]);

  // Live agents data
  const agents: CanvasAgent[] = agentsQuery?.data ?? [];
  const apiKeys: CanvasApiKey[] = apiKeysQuery?.data ?? [];
  const balance = creditBalance ?? 0;

  // Render minimized view
  if (!isMaximized) {
    switch (node.type) {
      case "health": {
        const healthy = agents.filter((a) => a.status === "running").length;
        const degraded = agents.filter(
          (a) => a.status === "error" || a.status === "disconnected",
        ).length;
        const stopped = agents.filter((a) =>
          ["stopped", "pending", "sleeping"].includes(a.status),
        ).length;
        return (
          <div className="w-full flex flex-col gap-3 p-1">
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-2 flex flex-col items-center">
                <span className="text-[9px] font-mono text-emerald-400 uppercase">
                  Healthy
                </span>
                <span className="text-sm font-bold text-emerald-400 mt-0.5">
                  {healthy}
                </span>
              </div>
              <div className="bg-rose-500/10 border border-rose-500/20 rounded-lg p-2 flex flex-col items-center">
                <span className="text-[9px] font-mono text-rose-400 uppercase">
                  Degraded
                </span>
                <span className="text-sm font-bold text-rose-400 mt-0.5">
                  {degraded}
                </span>
              </div>
              <div className="bg-white/[0.02] border border-white/[0.04] rounded-lg p-2 flex flex-col items-center">
                <span className="text-[9px] font-mono text-white/40 uppercase">
                  Stopped
                </span>
                <span className="text-sm font-bold text-white/60 mt-0.5">
                  {stopped}
                </span>
              </div>
            </div>
            <div className="flex flex-col gap-1.5 max-h-[180px] overflow-y-auto pr-1">
              {agents.length === 0 ? (
                <div className="text-[11px] text-white/30 text-center py-4">
                  No agents active.
                </div>
              ) : (
                agents.slice(0, 3).map((a) => (
                  <div
                    key={a.id}
                    className="flex justify-between items-center bg-white/[0.01] border border-white/[0.03] rounded-lg p-2 text-xs"
                  >
                    <span className="font-mono text-white/80 truncate max-w-[120px]">
                      {a.name}
                    </span>
                    <span
                      className={`text-[9px] px-1.5 py-0.5 rounded border font-bold uppercase ${
                        a.status === "running"
                          ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                          : a.status === "error" || a.status === "disconnected"
                            ? "bg-rose-500/10 border-rose-500/20 text-rose-400"
                            : "bg-zinc-500/10 border-zinc-500/20 text-zinc-400"
                      }`}
                    >
                      {a.status}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        );
      }

      case "agents": {
        if (isCreatingAgentMin) {
          return (
            <div className="w-full flex flex-col gap-3 p-1">
              <span className="text-[10px] font-bold font-mono tracking-widest text-white/30 uppercase border-b border-white/5 pb-1">
                Deploy Agent
              </span>
              <div className="flex flex-col gap-2.5 text-xs">
                <div className="flex flex-col gap-1 text-left">
                  <label className="font-mono text-[8px] text-white/40 uppercase font-bold">
                    Agent Name
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. trading-bot"
                    value={newAgentName}
                    onChange={(e) => setNewAgentName(e.target.value)}
                    className="bg-black/40 border border-white/10 rounded-lg px-2.5 py-1.5 text-white outline-none focus:border-[#FF5800]/50 text-xs"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2 text-left">
                  <div className="flex flex-col gap-1">
                    <label className="font-mono text-[8px] text-white/40 uppercase font-bold">
                      Flavor
                    </label>
                    <select
                      value={newAgentFlavor}
                      onChange={(e) => setNewAgentFlavor(e.target.value)}
                      className="bg-black/40 border border-white/10 rounded-lg px-2 py-1 text-white outline-none focus:border-[#FF5800]/50 text-xs"
                    >
                      <option value="eliza">Eliza</option>
                      <option value="dobby">Dobby</option>
                      <option value="trader">Trader</option>
                      <option value="support">Support</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="font-mono text-[8px] text-white/40 uppercase font-bold">
                      Tier
                    </label>
                    <select
                      value={newAgentTier}
                      onChange={(e) => setNewAgentTier(e.target.value)}
                      className="bg-black/40 border border-white/10 rounded-lg px-2 py-1 text-white outline-none focus:border-[#FF5800]/50 text-xs"
                    >
                      <option value="shared">Shared</option>
                      <option value="dedicated">Dedicated</option>
                    </select>
                  </div>
                </div>

                {deployError && (
                  <div className="text-[10px] text-rose-400 font-mono text-left">
                    ⚠ {deployError}
                  </div>
                )}

                <div className="flex gap-2 mt-1">
                  <button
                    type="button"
                    disabled={isDeployingAgent || !newAgentName.trim()}
                    onClick={async () => {
                      if (!newAgentName.trim()) return;
                      setIsDeployingAgent(true);
                      setDeployError(null);
                      try {
                        const createBody: CreateAgentBody = {
                          agentName: newAgentName.trim(),
                          autoProvision: true,
                        };
                        if (newAgentTier === "dedicated") {
                          createBody.dockerImage =
                            "ghcr.io/elizaos/eliza:stable";
                        }
                        const res = await api<{
                          success: boolean;
                          created?: boolean;
                          data?: {
                            id?: string;
                            agentId?: string;
                            sandboxId?: string;
                          };
                        }>("/api/v1/eliza/agents", {
                          method: "POST",
                          json: createBody,
                        });
                        if (res?.success) {
                          await agentsQuery.refetch();
                          setIsCreatingAgentMin(false);
                          setNewAgentName("");
                        } else {
                          throw new Error("Failed to deploy agent");
                        }
                      } catch (err) {
                        setDeployError(
                          err instanceof Error ? err.message : String(err),
                        );
                      } finally {
                        setIsDeployingAgent(false);
                      }
                    }}
                    className="flex-1 py-1 bg-[#FF5800] text-black font-bold text-xs rounded-lg hover:bg-[#ff7426] transition-all disabled:opacity-50 flex items-center justify-center gap-1 cursor-pointer"
                  >
                    {isDeployingAgent ? "Deploying..." : "Deploy"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsCreatingAgentMin(false);
                      setDeployError(null);
                    }}
                    className="flex-1 py-1 border border-white/10 hover:bg-white/5 text-white/60 hover:text-white text-xs rounded-lg transition-all cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          );
        }

        return (
          <div className="w-full flex flex-col gap-3 p-1">
            <div className="flex justify-between items-center text-[11px] font-mono text-white/40 border-b border-white/5 pb-1.5">
              <span>Agent Name</span>
              <span>Status / Toggle</span>
            </div>
            <div className="flex flex-col gap-2 max-h-[260px] overflow-y-auto pr-1">
              {agents.length === 0 ? (
                <div className="text-[11px] text-white/30 text-center py-4">
                  No agents deployed.
                </div>
              ) : (
                agents.map((agent) => (
                  <div
                    key={agent.id}
                    className="flex justify-between items-center bg-white/[0.02] border border-white/[0.04] rounded-lg p-2 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <div
                        className={`w-2 h-2 rounded-full ${agent.status === "running" ? "bg-emerald-400 animate-pulse shadow-[0_0_6px_#34d399]" : "bg-zinc-500"}`}
                      />
                      <span className="font-medium truncate max-w-[120px]">
                        {agent.name}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        const isRun = agent.status === "running";
                        await api(
                          isRun
                            ? `/api/v1/eliza/agents/${agent.id}`
                            : `/api/v1/eliza/agents/${agent.id}/resume`,
                          {
                            method: isRun ? "DELETE" : "POST",
                          },
                        );
                        agentsQuery.refetch();
                      }}
                      className={`px-2 py-0.5 rounded text-[10px] font-semibold border transition-colors cursor-pointer ${
                        agent.status === "running"
                          ? "bg-rose-500/10 border-rose-500/30 text-rose-400 hover:bg-rose-500/25"
                          : "bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25"
                      }`}
                    >
                      {agent.status === "running" ? "Stop" : "Resume"}
                    </button>
                  </div>
                ))
              )}
            </div>
            <button
              type="button"
              onClick={() => setIsCreatingAgentMin(true)}
              className="w-full mt-2 py-1.5 text-center text-xs border border-dashed border-white/10 hover:border-[#FF5800]/40 rounded-lg text-white/50 hover:text-white bg-white/[0.01] hover:bg-white/[0.03] transition-all cursor-pointer"
            >
              + Deploy New Agent
            </button>
          </div>
        );
      }

      case "billing":
        return (
          <div className="w-full flex flex-col items-center gap-4 p-2 text-center">
            {/* Glossy Credit Card Mock */}
            <div className="w-full h-32 rounded-xl relative overflow-hidden bg-gradient-to-br from-indigo-500/20 via-purple-500/10 to-pink-500/20 border border-white/10 shadow-[0_12px_24px_rgba(0,0,0,0.5)] flex flex-col justify-between p-4 text-left">
              <div className="absolute inset-0 bg-radial-gradient(circle at 10% 20%, rgba(255,88,0,0.1) 0%, transparent 60%)" />
              <div className="flex justify-between items-start z-10">
                <span className="text-[10px] font-mono tracking-widest text-white/40 uppercase">
                  Eliza Cloud Credits
                </span>
                <CreditCard className="h-4 w-4 text-indigo-400" />
              </div>
              <div className="z-10">
                <span className="text-2xl font-bold tracking-tight text-white">
                  ${Number(balance).toFixed(2)}
                </span>
                <p className="text-[8px] font-mono text-emerald-400 uppercase tracking-widest mt-0.5 animate-pulse">
                  ● Balance Active
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => runPrompt("show billing overview")}
              className="w-full py-1.5 bg-[#FF5800] text-black font-bold text-xs rounded-lg hover:bg-[#ff7426] transition-all active:scale-[0.98]"
            >
              Add Credits
            </button>
          </div>
        );

      case "apikeys":
        return (
          <div className="w-full flex flex-col gap-2.5 p-1">
            <div className="flex justify-between items-center text-[11px] font-mono text-white/40 border-b border-white/5 pb-1">
              <span>Key Label</span>
              <span>Value</span>
            </div>
            <div className="flex flex-col gap-1.5 max-h-[160px] overflow-y-auto pr-1">
              {apiKeys.length === 0 ? (
                <div className="text-[11px] text-white/30 text-center py-4">
                  No API keys.
                </div>
              ) : (
                apiKeys.slice(0, 4).map((k) => (
                  <div
                    key={k.id}
                    className="flex justify-between items-center bg-white/[0.01] border border-white/[0.03] rounded-lg p-2 text-xs"
                  >
                    <span className="font-mono text-white/80 truncate max-w-[100px]">
                      {k.name}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-white/30 text-[10px]">
                        eliza_••••{k.token?.slice(-4) || "4a2b"}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(
                            k.token || "mock-key-token",
                          );
                        }}
                        className="p-1 rounded hover:bg-white/5 text-white/40 hover:text-white transition-colors"
                        title="Copy Key"
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Quick Paste Import */}
            <div className="mt-1 border-t border-white/5 pt-2">
              <span className="text-[9px] font-mono text-white/40 uppercase block mb-1">
                Quick Set / Paste Keys (one per line or name=scope)
              </span>
              <div className="flex gap-1.5">
                <textarea
                  value={quickPasteText}
                  onChange={(e) => setQuickPasteText(e.target.value)}
                  placeholder="e.g. OpenAI Key&#10;Anthropic=read_only"
                  className="flex-1 min-h-[36px] max-h-[48px] bg-black/40 border border-white/10 rounded-lg p-1.5 text-[9px] text-white outline-none focus:border-[#FF5800]/50 placeholder-white/20 font-mono resize-none"
                />
                <button
                  type="button"
                  onClick={handleQuickSaveKeys}
                  disabled={isSavingQuickPaste || !quickPasteText.trim()}
                  className="px-2.5 bg-[#FF5800] text-black font-bold text-[9px] rounded-lg hover:bg-[#ff7426] transition-all active:scale-[0.98] disabled:opacity-35 disabled:cursor-not-allowed shrink-0 flex items-center justify-center cursor-pointer"
                >
                  {isSavingQuickPaste ? "Saving..." : "Quick Save"}
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={() => runPrompt("show API keys")}
              className="w-full mt-1 py-1.5 text-center text-xs border border-dashed border-white/10 hover:border-[#FF5800]/40 rounded-lg text-white/50 hover:text-white bg-white/[0.01] hover:bg-white/[0.03] transition-all cursor-pointer"
            >
              Manage Keys
            </button>
          </div>
        );

      case "analytics": {
        const runCount = agents.filter((a) => a.status === "running").length;
        const totalCount = agents.length;
        const pct =
          totalCount > 0 ? Math.round((runCount / totalCount) * 100) : 0;
        return (
          <div className="w-full flex flex-col gap-4 p-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-white/[0.02] border border-white/[0.04] rounded-xl p-3 flex flex-col items-center">
                <span className="text-[9px] font-mono text-white/40 uppercase">
                  Utilization
                </span>
                <span className="text-lg font-bold text-sky-400 mt-1">
                  {pct}%
                </span>
              </div>
              <div className="bg-white/[0.02] border border-white/[0.04] rounded-xl p-3 flex flex-col items-center">
                <span className="text-[9px] font-mono text-white/40 uppercase">
                  Agents
                </span>
                <span className="text-lg font-bold text-indigo-400 mt-1">
                  {runCount}/{totalCount}
                </span>
              </div>
            </div>
            <div className="bg-white/[0.02] border border-white/[0.04] rounded-xl p-3 flex items-center justify-between text-xs">
              <div className="flex items-center gap-1.5 text-white/60">
                <Globe className="h-3.5 w-3.5 text-emerald-400" />
                <span>Active API Keys</span>
              </div>
              <span className="font-bold text-white">
                {Array.isArray(apiKeysQuery?.data)
                  ? apiKeysQuery.data.filter((k) => k.is_active).length
                  : 0}
              </span>
            </div>
          </div>
        );
      }

      case "security":
        return (
          <div className="w-full flex flex-col gap-3 p-1">
            <div className="flex items-center gap-3 bg-white/[0.02] border border-white/[0.04] rounded-xl p-3">
              <Shield className="h-6 w-6 text-emerald-400 shrink-0" />
              <div className="text-left">
                <p className="text-xs font-semibold text-white">
                  Security Console
                </p>
                <p className="text-[9px] text-white/40 font-mono">
                  PCI-DSS / SOC-2 Compliant
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-2 text-xs">
              <div className="flex justify-between items-center bg-black/20 p-2 rounded-lg">
                <span>Multi-Factor Auth (MFA)</span>
                <span className="text-emerald-400 font-semibold">Enabled</span>
              </div>
              <div className="flex justify-between items-center bg-black/20 p-2 rounded-lg">
                <span>Single Sign-On (SSO)</span>
                <span className="text-white/40">Not Configured</span>
              </div>
            </div>
          </div>
        );

      case "connectors":
        return (
          <div className="w-full grid grid-cols-2 gap-2.5 p-1">
            {Object.entries(connectors).map(([platform, active]) => (
              <div
                key={platform}
                className="bg-white/[0.02] border border-white/[0.04] rounded-xl p-2.5 flex flex-col justify-between h-20"
              >
                <div className="flex justify-between items-center">
                  <span className="text-xs font-semibold uppercase font-mono tracking-wider text-white/85">
                    {platform}
                  </span>
                  <div
                    className={`w-1.5 h-1.5 rounded-full ${active ? "bg-emerald-400 shadow-[0_0_4px_#34d399]" : "bg-zinc-600"}`}
                  />
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setConnectors((prev) => ({
                      ...prev,
                      [platform]: !prev[platform],
                    }))
                  }
                  className={`w-full py-1 rounded text-[10px] font-bold border transition-colors ${
                    active
                      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20"
                      : "bg-white/5 border-white/10 text-white/50 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  {active ? "Active" : "Connect"}
                </button>
              </div>
            ))}
          </div>
        );

      case "mcps":
        return (
          <div className="w-full flex flex-col gap-2.5 p-1">
            <div className="flex justify-between items-center text-[11px] font-mono text-white/40 border-b border-white/5 pb-1">
              <span>MCP Server</span>
              <span>Tools</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between items-center bg-white/[0.01] border border-white/[0.03] rounded-lg p-2 text-xs">
                <span className="font-mono font-medium">github</span>
                <span className="bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[9px] px-1.5 py-0.5 rounded font-mono">
                  14 tools
                </span>
              </div>
              <div className="flex justify-between items-center bg-white/[0.01] border border-white/[0.03] rounded-lg p-2 text-xs">
                <span className="font-mono font-medium">gdrive</span>
                <span className="bg-sky-500/10 text-sky-400 border border-sky-500/20 text-[9px] px-1.5 py-0.5 rounded font-mono">
                  8 tools
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => runPrompt("show MCPs")}
              className="w-full mt-2 py-1.5 text-center text-xs border border-dashed border-white/10 hover:border-[#FF5800]/40 rounded-lg text-white/50 hover:text-white bg-white/[0.01] hover:bg-white/[0.03] transition-all"
            >
              Configure MCP Servers
            </button>
          </div>
        );

      case "containers":
        return (
          <div className="w-full flex flex-col gap-2.5 p-1">
            <div className="flex justify-between items-center text-[11px] font-mono text-white/40 border-b border-white/5 pb-1">
              <span>Container Image</span>
              <span>Status</span>
            </div>
            <div className="flex flex-col gap-1.5 max-h-[260px] overflow-y-auto pr-1">
              {containers.length === 0 ? (
                <div className="text-[11px] text-white/30 text-center py-4">
                  No containers deployed.
                </div>
              ) : (
                containers.slice(0, 4).map((c) => (
                  <div
                    key={c.id}
                    className="flex justify-between items-center bg-white/[0.01] border border-white/[0.03] rounded-lg p-2 text-xs"
                  >
                    <span className="font-mono text-white/80 truncate max-w-[150px]">
                      {c.image?.split("/").pop() || c.name}
                    </span>
                    <span
                      className={`text-[9px] px-1.5 py-0.5 rounded border uppercase font-bold ${
                        c.status === "running" || c.status === "active"
                          ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                          : "bg-zinc-500/10 border-zinc-500/20 text-zinc-400"
                      }`}
                    >
                      {c.status}
                    </span>
                  </div>
                ))
              )}
            </div>
            <button
              type="button"
              onClick={() => runPrompt("deploy a container")}
              className="w-full mt-2 py-1.5 text-center text-xs border border-dashed border-white/10 hover:border-[#FF5800]/40 rounded-lg text-white/50 hover:text-white bg-white/[0.01] hover:bg-white/[0.03] transition-all"
            >
              + Deploy Container
            </button>
          </div>
        );

      case "domains":
        return (
          <div className="w-full flex flex-col gap-2.5 p-1">
            <div className="flex justify-between items-center text-[11px] font-mono text-white/40 border-b border-white/5 pb-1">
              <span>Domain</span>
              <span>Status</span>
            </div>
            <div className="flex flex-col gap-1.5 max-h-[260px] overflow-y-auto pr-1">
              {domains.length === 0 ? (
                <div className="text-[11px] text-white/30 text-center py-4">
                  No domains registered.
                </div>
              ) : (
                domains.slice(0, 4).map((d) => (
                  <div
                    key={d.id}
                    className="flex justify-between items-center bg-white/[0.01] border border-white/[0.03] rounded-lg p-2 text-xs"
                  >
                    <span className="font-mono text-white/80 truncate max-w-[150px]">
                      {d.domain}
                    </span>
                    <span
                      className={`text-[9px] px-1.5 py-0.5 rounded border uppercase font-bold ${
                        d.verified
                          ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                          : "bg-amber-500/10 border-amber-500/20 text-amber-400"
                      }`}
                    >
                      {d.verified ? "verified" : "pending"}
                    </span>
                  </div>
                ))
              )}
            </div>
            <button
              type="button"
              onClick={() => runPrompt("add a custom domain")}
              className="w-full mt-2 py-1.5 text-center text-xs border border-dashed border-white/10 hover:border-[#FF5800]/40 rounded-lg text-white/50 hover:text-white bg-white/[0.01] hover:bg-white/[0.03] transition-all"
            >
              + Add Custom Domain
            </button>
          </div>
        );

      case "remote":
      case "remotePairing":
        return (
          <div className="w-full flex flex-col gap-3 p-1">
            <div className="flex items-center gap-3 bg-white/[0.02] border border-white/[0.04] rounded-xl p-3">
              <Link2 className="h-6 w-6 text-emerald-400 shrink-0 animate-pulse" />
              <div className="text-left">
                <p className="text-xs font-semibold text-white">
                  Remote Sessions
                </p>
                <p className="text-[9px] text-white/40 font-mono">
                  {remoteSessions.length} active connection(s)
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => runPrompt("pair my phone")}
              className="w-full py-1.5 bg-[#FF5800] text-black font-bold text-xs rounded-lg hover:bg-[#ff7426] transition-all active:scale-[0.98]"
            >
              Pair New Device
            </button>
          </div>
        );

      case "profile": {
        return (
          <div className="w-full flex flex-col gap-3 p-1">
            <div className="flex items-center gap-3 bg-white/[0.02] border border-white/[0.06] rounded-xl p-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#FF5800]/30 to-[#FF5800]/10 border border-[#FF5800]/30 flex items-center justify-center shrink-0">
                <User className="w-5 h-5 text-[#FF5800]" />
              </div>
              <div className="min-w-0 text-left">
                <p className="text-xs font-bold text-white truncate">
                  {(
                    node as WorkspaceNode & { _userEmail?: string }
                  )._userEmail?.split("@")[0] || "User"}
                </p>
                <p className="text-[9px] text-white/40 font-mono truncate">
                  {(node as WorkspaceNode & { _userEmail?: string })
                    ._userEmail || "Loading..."}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="bg-white/[0.01] border border-white/[0.04] rounded-lg p-2 flex flex-col items-center">
                <span className="text-[8px] font-mono text-white/30 uppercase">
                  Role
                </span>
                <span className="text-[10px] font-bold text-[#FF5800] mt-0.5">
                  Admin
                </span>
              </div>
              <div className="bg-white/[0.01] border border-white/[0.04] rounded-lg p-2 flex flex-col items-center">
                <span className="text-[8px] font-mono text-white/30 uppercase">
                  Status
                </span>
                <span className="text-[10px] font-bold text-emerald-400 mt-0.5">
                  Active
                </span>
              </div>
            </div>
          </div>
        );
      }

      case "apps": {
        return (
          <div className="w-full flex flex-col gap-3 p-1">
            <div className="flex items-center justify-between bg-white/[0.02] border border-white/[0.06] rounded-xl p-3">
              <div className="flex items-center gap-2">
                <AppWindow className="w-4 h-4 text-purple-400" />
                <span className="text-xs font-bold text-white">
                  Registered Apps
                </span>
              </div>
              <span className="text-sm font-bold text-purple-400 font-mono">
                —
              </span>
            </div>
            <p className="text-[10px] text-white/30 font-mono text-center">
              Expand to view and manage apps
            </p>
          </div>
        );
      }
      case "earnings": {
        const avail = earningsBalance?.balance?.availableBalance ?? 0;
        const total = earningsBalance?.balance?.totalEarned ?? 0;
        const redeemed = earningsBalance?.balance?.totalRedeemed ?? 0;
        return (
          <div className="w-full flex flex-col gap-3 p-1">
            <div className="flex items-center gap-3 bg-white/[0.02] border border-white/[0.06] rounded-xl p-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-yellow-500/30 to-yellow-500/10 border border-yellow-500/30 flex items-center justify-center shrink-0 animate-pulse">
                <Coins className="w-5 h-5 text-yellow-400" />
              </div>
              <div className="min-w-0 text-left">
                <p className="text-xs font-bold text-white truncate">
                  Earnings & Proceeds
                </p>
                <p className="text-[10px] text-white/40 truncate">
                  Available:{" "}
                  <span className="font-semibold text-green-400">
                    ${avail.toFixed(2)}
                  </span>
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="bg-white/[0.01] border border-white/[0.04] rounded-lg p-2 flex flex-col items-center">
                <span className="text-[8px] font-mono text-white/30 uppercase">
                  Total Earned
                </span>
                <span className="text-[10px] font-bold text-white mt-0.5 font-mono">
                  ${total.toFixed(2)}
                </span>
              </div>
              <div className="bg-white/[0.01] border border-white/[0.04] rounded-lg p-2 flex flex-col items-center">
                <span className="text-[8px] font-mono text-white/30 uppercase">
                  Redeemed
                </span>
                <span className="text-[10px] font-bold text-white/60 mt-0.5 font-mono">
                  ${redeemed.toFixed(2)}
                </span>
              </div>
            </div>
          </div>
        );
      }

      case "affiliates": {
        return (
          <div className="w-full flex flex-col gap-3 p-1">
            <div className="flex items-center gap-3 bg-white/[0.02] border border-white/[0.06] rounded-xl p-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-rose-500/30 to-rose-500/10 border border-rose-500/30 flex items-center justify-center shrink-0">
                <Share2 className="w-5 h-5 text-rose-400" />
              </div>
              <div className="min-w-0 text-left">
                <p className="text-xs font-bold text-white truncate">
                  Affiliates & Invites
                </p>
                <p className="text-[10px] text-white/40 truncate">
                  Earn 20% commission on spend
                </p>
              </div>
            </div>
          </div>
        );
      }

      case "documents": {
        return (
          <div className="w-full flex flex-col gap-3 p-1">
            <div className="flex items-center gap-3 bg-white/[0.02] border border-white/[0.06] rounded-xl p-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500/30 to-blue-500/10 border border-blue-500/30 flex items-center justify-center shrink-0">
                <FileCode className="w-5 h-5 text-blue-400" />
              </div>
              <div className="min-w-0 text-left">
                <p className="text-xs font-bold text-white truncate">
                  Documents & Files
                </p>
                <p className="text-[10px] text-white/40 truncate">
                  Manage agent knowledge files
                </p>
              </div>
            </div>
          </div>
        );
      }

      case "settings": {
        return (
          <div className="w-full flex flex-col gap-3 p-1">
            <div className="flex items-center gap-3 bg-white/[0.02] border border-white/[0.06] rounded-xl p-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-zinc-500/30 to-zinc-500/10 border border-zinc-500/30 flex items-center justify-center shrink-0">
                <Settings className="w-5 h-5 text-zinc-400" />
              </div>
              <div className="min-w-0 text-left">
                <p className="text-xs font-bold text-white truncate">
                  General Settings
                </p>
                <p className="text-[10px] text-white/40 truncate">
                  Manage dashboard preferences
                </p>
              </div>
            </div>
          </div>
        );
      }

      case "api-explorer": {
        return (
          <div className="w-full flex flex-col gap-3 p-1">
            <div className="flex items-center gap-3 bg-white/[0.02] border border-white/[0.06] rounded-xl p-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-emerald-500/30 to-emerald-500/10 border border-emerald-500/30 flex items-center justify-center shrink-0">
                <Terminal className="w-5 h-5 text-emerald-400" />
              </div>
              <div className="min-w-0 text-left">
                <p className="text-xs font-bold text-white truncate">
                  API Explorer
                </p>
                <p className="text-[10px] text-white/40 truncate">
                  Test platform API endpoints
                </p>
              </div>
            </div>
          </div>
        );
      }

      case "admin": {
        return (
          <div className="w-full flex flex-col gap-3 p-1">
            <div className="flex items-center gap-3 bg-white/[0.02] border border-white/[0.06] rounded-xl p-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-red-500/30 to-red-500/10 border border-red-500/30 flex items-center justify-center shrink-0">
                <Shield className="w-5 h-5 text-red-400" />
              </div>
              <div className="min-w-0 text-left">
                <p className="text-xs font-bold text-white truncate">
                  Admin Panel
                </p>
                <p className="text-[10px] text-white/40 truncate">
                  Moderate users & redemptions
                </p>
              </div>
            </div>
          </div>
        );
      }

      default:
        return null;
    }
  }

  // Render maximized view
  switch (node.type) {
    case "health": {
      return (
        <div className="w-full h-full overflow-y-auto p-2 bg-black/40 backdrop-blur-md rounded-xl border border-white/10 animate-fade-up">
          <Suspense fallback={<DnaLoader />}>
            <ApiExplorerPage />
          </Suspense>
        </div>
      );
    }

    case "agents": {
      const isDeploying = selectedItem === "deploy";
      const activeAgent = isDeploying
        ? null
        : agents.find((a) => a.id === selectedItem) || agents[0];
      return (
        <div className="w-full h-full flex gap-6 text-left select-text p-2 animate-fade-up">
          {/* Sidebar */}
          <div className="w-64 shrink-0 flex flex-col gap-2 border-r border-white/10 pr-6">
            <span className="text-[10px] font-bold font-mono tracking-widest text-white/30 uppercase">
              Instances
            </span>
            <div className="flex flex-col gap-1.5 overflow-y-auto flex-1">
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => {
                    setSelectedItem(agent.id);
                    setActiveTab("overview");
                  }}
                  className={`w-full flex items-center justify-between p-3 rounded-xl border text-left transition-all cursor-pointer ${
                    activeAgent?.id === agent.id
                      ? "bg-white/[0.04] border-[#FF5800]/50 shadow-[0_4px_12px_rgba(255,88,0,0.05)] text-white"
                      : "bg-transparent border-white/5 text-white/60 hover:bg-white/[0.02]"
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div
                      className={`w-2 h-2 rounded-full shrink-0 ${agent.status === "running" ? "bg-emerald-400 animate-pulse shadow-[0_0_6px_#34d399]" : "bg-zinc-500"}`}
                    />
                    <span className="font-semibold text-xs truncate">
                      {agent.name}
                    </span>
                  </div>
                  <span className="text-[9px] font-mono text-white/30 uppercase">
                    {agent.runtime || "node"}
                  </span>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setSelectedItem("deploy")}
              className={`w-full py-2 border border-dashed rounded-xl text-center text-xs transition-all cursor-pointer ${
                selectedItem === "deploy"
                  ? "border-[#FF5800]/50 text-white bg-white/[0.04]"
                  : "border-white/10 hover:border-[#FF5800]/40 text-white/50 hover:text-white bg-white/[0.01]"
              }`}
            >
              + Deploy Agent
            </button>
          </div>

          {/* Main Content Area */}
          <div className="flex-1 flex flex-col min-w-0">
            {activeAgent ? (
              <>
                {/* Header Info */}
                <div className="flex justify-between items-start border-b border-white/10 pb-4 mb-4">
                  <div>
                    <h2 className="text-xl font-bold text-zinc-100 flex items-center gap-3">
                      {activeAgent.name}
                      <span
                        className={`px-2 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider ${
                          activeAgent.status === "running"
                            ? "bg-emerald-400/10 text-emerald-400 border border-emerald-400/20"
                            : "bg-zinc-500/10 text-zinc-400 border border-zinc-500/20"
                        }`}
                      >
                        {activeAgent.status}
                      </span>
                    </h2>
                    <p className="text-xs text-white/30 font-mono mt-1">
                      ID: {activeAgent.id}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        const isRun = activeAgent.status === "running";
                        await api(
                          isRun
                            ? `/api/v1/eliza/agents/${activeAgent.id}`
                            : `/api/v1/eliza/agents/${activeAgent.id}/resume`,
                          {
                            method: isRun ? "DELETE" : "POST",
                          },
                        );
                        agentsQuery.refetch();
                      }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
                        activeAgent.status === "running"
                          ? "bg-rose-500/10 border-rose-500/30 text-rose-400 hover:bg-rose-500/25"
                          : "bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25"
                      }`}
                    >
                      {activeAgent.status === "running"
                        ? "Suspend Instance"
                        : "Start Instance"}
                    </button>
                  </div>
                </div>

                {/* Sub tabs */}
                <div className="flex gap-1.5 border-b border-white/5 pb-2 mb-4 text-xs font-mono">
                  {["overview", "chat", "logs", "settings", "plugins"].map(
                    (tab) => (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => setActiveTab(tab)}
                        className={`tab-btn px-3 py-1 rounded transition-colors uppercase tracking-wider text-[10px] ${
                          activeTab === tab
                            ? "bg-white/10 text-white font-semibold"
                            : "text-white/40 hover:text-white/70 hover:bg-white/5"
                        }`}
                      >
                        {tab}
                      </button>
                    ),
                  )}
                </div>

                {/* Tab contents */}
                <div className="flex-1 min-h-0 overflow-y-auto">
                  {activeTab === "overview" && (
                    <div className="grid grid-cols-2 gap-4 text-xs">
                      <div className="bg-white/[0.02] border border-white/[0.04] rounded-xl p-4 flex flex-col gap-2">
                        <span className="text-[10px] font-bold font-mono tracking-widest text-white/30 uppercase">
                          Runtime Health
                        </span>
                        <div className="flex justify-between items-center py-1 border-b border-white/5">
                          <span className="text-white/60">Uptime</span>
                          <span className="font-semibold text-white/90">
                            2d 14h 5m
                          </span>
                        </div>
                        <div className="flex justify-between items-center py-1 border-b border-white/5">
                          <span className="text-white/60">
                            Messages Processed
                          </span>
                          <span className="font-semibold text-white/90">
                            1,402
                          </span>
                        </div>
                        <div className="flex justify-between items-center py-1">
                          <span className="text-white/60">Avg Latency</span>
                          <span className="font-semibold text-white/90">
                            482ms
                          </span>
                        </div>
                      </div>

                      <div className="bg-white/[0.02] border border-white/[0.04] rounded-xl p-4 flex flex-col gap-2">
                        <span className="text-[10px] font-bold font-mono tracking-widest text-white/30 uppercase">
                          Specifications
                        </span>
                        <div className="flex justify-between items-center py-1 border-b border-white/5">
                          <span className="text-white/60">Model</span>
                          <span className="font-semibold text-white/90">
                            GPT-4o / Claude 3.5
                          </span>
                        </div>
                        <div className="flex justify-between items-center py-1 border-b border-white/5">
                          <span className="text-white/60">Memory Node</span>
                          <span className="font-semibold text-white/90">
                            PostgreSQL (Remote)
                          </span>
                        </div>
                        <div className="flex justify-between items-center py-1">
                          <span className="text-white/60">
                            Agent Core version
                          </span>
                          <span className="font-semibold text-white/90">
                            v1.2.0-beta
                          </span>
                        </div>
                      </div>
                    </div>
                  )}

                  {activeTab === "chat" && (
                    <div className="flex flex-col h-[380px] bg-black/40 border border-white/10 rounded-xl overflow-hidden animate-fade-up">
                      {/* Message area */}
                      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 scrollbar-thin">
                        {chatMessages.length === 0 ? (
                          <div className="flex-1 flex flex-col items-center justify-center text-center text-[11px] text-white/30 font-mono gap-2">
                            <div className="p-3 bg-white/[0.01] border border-white/5 rounded-full text-[#FF5800]">
                              <MessageSquare className="h-5 w-5" />
                            </div>
                            <span>
                              Send a message to start chatting with{" "}
                              {activeAgent.name}
                            </span>
                          </div>
                        ) : (
                          chatMessages.map((msg) => (
                            <div
                              key={msg.id}
                              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                            >
                              <div
                                className={`max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed select-text ${
                                  msg.role === "user"
                                    ? "bg-[#FF5800]/10 border border-[#FF5800]/30 text-white"
                                    : msg.role === "agent"
                                      ? "bg-white/[0.04] border border-white/5 text-white/90"
                                      : "bg-rose-500/10 border border-rose-500/20 text-rose-400"
                                }`}
                              >
                                {msg.text}
                              </div>
                            </div>
                          ))
                        )}
                        {isSendingChat && (
                          <div className="flex justify-start animate-pulse">
                            <div className="inline-flex items-center gap-2 bg-white/[0.04] border border-white/5 rounded-xl px-3 py-2 text-xs text-white/40 font-mono">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              waiting for reply...
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Input form */}
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          sendAgentMessage(activeAgent.id);
                        }}
                        className="border-t border-white/5 p-2 bg-black/20 flex gap-2"
                      >
                        <input
                          type="text"
                          value={chatInput}
                          onChange={(e) => setChatInput(e.target.value)}
                          disabled={
                            isSendingChat || activeAgent.status !== "running"
                          }
                          placeholder={
                            activeAgent.status === "running"
                              ? `Message ${activeAgent.name}...`
                              : "Instance must be running to chat"
                          }
                          className="flex-1 bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-[#FF5800]/50 placeholder-white/20"
                        />
                        <button
                          type="submit"
                          disabled={
                            !chatInput.trim() ||
                            isSendingChat ||
                            activeAgent.status !== "running"
                          }
                          className="px-3 bg-[#FF5800] text-black font-bold text-xs rounded-lg hover:bg-[#ff7426] transition-all disabled:opacity-40 disabled:cursor-not-allowed shrink-0 flex items-center justify-center cursor-pointer"
                        >
                          Send
                        </button>
                      </form>
                    </div>
                  )}

                  {activeTab === "logs" && (
                    <div className="w-full h-48 bg-black/60 border border-white/10 rounded-xl p-3 font-mono text-[10px] text-zinc-400 overflow-y-auto flex flex-col gap-1 select-text scrollbar-thin">
                      <p>
                        <span className="text-sky-400">
                          [2026-06-08 00:01:12]
                        </span>{" "}
                        <span className="text-emerald-400">INFO:</span>{" "}
                        Initializing Eliza Framework core...
                      </p>
                      <p>
                        <span className="text-sky-400">
                          [2026-06-08 00:01:13]
                        </span>{" "}
                        <span className="text-emerald-400">INFO:</span>{" "}
                        Connecting to PostgreSQL Database...
                      </p>
                      <p>
                        <span className="text-sky-400">
                          [2026-06-08 00:01:14]
                        </span>{" "}
                        <span className="text-emerald-400">INFO:</span> DB
                        Connection Successful. Migrations checked.
                      </p>
                      <p>
                        <span className="text-sky-400">
                          [2026-06-08 00:01:15]
                        </span>{" "}
                        <span className="text-amber-400">WARN:</span> Missing
                        optional environment variable GITHUB_PAT
                      </p>
                      <p>
                        <span className="text-sky-400">
                          [2026-06-08 00:01:16]
                        </span>{" "}
                        <span className="text-emerald-400">INFO:</span>{" "}
                        Launching Discord Connector...
                      </p>
                      <p>
                        <span className="text-sky-400">
                          [2026-06-08 00:01:18]
                        </span>{" "}
                        <span className="text-emerald-400">INFO:</span> Discord
                        bot connected as @ElizaOSHelper
                      </p>
                      <p>
                        <span className="text-sky-400">
                          [2026-06-08 00:03:45]
                        </span>{" "}
                        <span className="text-violet-400">DEBUG:</span> Received
                        message: "hello" in Discord Channel #general
                      </p>
                      <p>
                        <span className="text-sky-400">
                          [2026-06-08 00:03:47]
                        </span>{" "}
                        <span className="text-violet-400">DEBUG:</span>{" "}
                        Generating reply using model gpt-4o...
                      </p>
                      <p>
                        <span className="text-sky-400">
                          [2026-06-08 00:03:48]
                        </span>{" "}
                        <span className="text-emerald-400">INFO:</span> Replied
                        to user successfully (482ms).
                      </p>
                    </div>
                  )}

                  {activeTab === "settings" && (
                    <div className="flex flex-col gap-3 max-w-lg text-xs">
                      {Object.entries(envVars).map(([key, val]) => (
                        <div key={key} className="flex flex-col gap-1.5">
                          <label className="font-mono text-[10px] text-white/40 uppercase font-bold">
                            {key}
                          </label>
                          <div className="flex gap-2">
                            <input
                              type={
                                key.includes("KEY") || key.includes("TOKEN")
                                  ? showApiKey
                                    ? "text"
                                    : "password"
                                  : "text"
                              }
                              value={val}
                              onChange={(e) =>
                                setEnvVars((prev) => ({
                                  ...prev,
                                  [key]: e.target.value,
                                }))
                              }
                              className="flex-1 bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-white outline-none focus:border-[#FF5800]/50"
                            />
                            {key.includes("KEY") || key.includes("TOKEN") ? (
                              <button
                                type="button"
                                onClick={() => setShowApiKey(!showApiKey)}
                                className="px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-colors"
                              >
                                {showApiKey ? "Hide" : "Show"}
                              </button>
                            ) : null}
                          </div>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => alert("Settings saved successfully!")}
                        className="w-full mt-2 py-2 bg-[#FF5800] text-black font-bold rounded-lg hover:bg-[#ff7426] transition-all"
                      >
                        Save Configuration
                      </button>
                    </div>
                  )}

                  {activeTab === "plugins" && (
                    <div className="grid grid-cols-2 gap-3">
                      {Object.entries(activePlugins).map(([plug, active]) => (
                        <div
                          key={plug}
                          className="flex justify-between items-center bg-white/[0.01] border border-white/[0.04] rounded-xl p-3.5"
                        >
                          <div className="flex flex-col">
                            <span className="font-mono font-bold text-xs uppercase tracking-wide text-white/80">
                              {plug.replace("-", " ")}
                            </span>
                            <span className="text-[10px] text-white/30">
                              Plugin description here
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              setActivePlugins((prev) => ({
                                ...prev,
                                [plug]: !prev[plug],
                              }))
                            }
                            className={`px-3 py-1 rounded-lg text-[10px] font-bold border transition-colors ${
                              active
                                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20"
                                : "bg-white/5 border-white/10 text-white/50 hover:bg-white/10 hover:text-white"
                            }`}
                          >
                            {active ? "Enabled" : "Disabled"}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : isDeploying || agents.length === 0 ? (
              <div className="w-full h-full flex flex-col gap-4 text-left p-4 animate-fade-up">
                <div className="flex justify-between items-center border-b border-white/10 pb-4 mb-2">
                  <div>
                    <h2 className="text-lg font-bold text-zinc-100 uppercase font-mono">
                      Deploy New Agent Instance
                    </h2>
                    <p className="text-xs text-white/30 font-mono mt-1">
                      Configure your agent character, execution tier and
                      environment variables
                    </p>
                  </div>
                  {agents.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelectedItem(agents[0].id)}
                      className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-white/60 hover:text-white text-xs font-bold transition-all cursor-pointer"
                    >
                      Cancel
                    </button>
                  )}
                </div>

                <div className="flex-1 overflow-y-auto flex gap-6 pr-1 min-h-0 text-xs text-left">
                  {/* Left Panel: Basic Config */}
                  <div className="w-80 shrink-0 flex flex-col gap-4 border-r border-white/10 pr-6">
                    <div className="flex flex-col gap-1.5">
                      <label className="font-mono text-[9px] text-white/40 uppercase font-bold">
                        Agent Instance Name
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. trading-assistant"
                        value={newAgentName}
                        onChange={(e) => setNewAgentName(e.target.value)}
                        className="bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-white outline-none focus:border-[#FF5800]/50"
                      />
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="font-mono text-[9px] text-white/40 uppercase font-bold">
                        Character / Flavor
                      </label>
                      <select
                        value={newAgentFlavor}
                        onChange={(e) => {
                          const flavor = e.target.value;
                          setNewAgentFlavor(flavor);
                          if (flavor === "custom") {
                            setNewAgentTier("dedicated");
                          }
                        }}
                        className="bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-white outline-none focus:border-[#FF5800]/50"
                      >
                        <option value="eliza">Eliza (default)</option>
                        <option value="dobby">Dobby (helpful house-elf)</option>
                        <option value="trader">Trading Agent</option>
                        <option value="support">Customer Support</option>
                        <option value="custom">Custom Docker Image</option>
                      </select>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="font-mono text-[9px] text-white/40 uppercase font-bold">
                        Execution Tier
                      </label>
                      <select
                        value={newAgentTier}
                        onChange={(e) => setNewAgentTier(e.target.value)}
                        disabled={newAgentFlavor === "custom"}
                        className="bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-white outline-none focus:border-[#FF5800]/50 disabled:opacity-50"
                      >
                        <option value="shared">
                          Shared Runtime (cheapest, auto-sleeps)
                        </option>
                        <option value="dedicated">
                          Dedicated Sandbox (always-on, stateful)
                        </option>
                      </select>
                    </div>

                    {(newAgentTier === "dedicated" ||
                      newAgentFlavor === "custom") && (
                      <div className="flex flex-col gap-1.5 animate-fade-in">
                        <label className="font-mono text-[9px] text-white/40 uppercase font-bold">
                          Docker Image Reference
                        </label>
                        <input
                          type="text"
                          placeholder="ghcr.io/elizaos/eliza:stable"
                          value={newAgentDockerImage}
                          onChange={(e) =>
                            setNewAgentDockerImage(e.target.value)
                          }
                          className="bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-white outline-none focus:border-[#FF5800]/50 font-mono"
                        />
                      </div>
                    )}

                    {deployError && (
                      <div className="text-rose-400 text-xs font-mono p-2 border border-rose-500/20 bg-rose-500/5 rounded-lg">
                        ⚠ {deployError}
                      </div>
                    )}

                    <button
                      type="button"
                      disabled={isDeployingAgent || !newAgentName.trim()}
                      onClick={async () => {
                        if (!newAgentName.trim()) return;
                        setIsDeployingAgent(true);
                        setDeployError(null);
                        try {
                          const envVarsMap: Record<string, string> = {};
                          for (const pair of newAgentEnvVars) {
                            if (pair.key.trim() && pair.value.trim()) {
                              envVarsMap[pair.key.trim()] = pair.value.trim();
                            }
                          }

                          const createBody: CreateAgentBody = {
                            agentName: newAgentName.trim(),
                            autoProvision: true,
                            environmentVars: envVarsMap,
                          };

                          if (
                            newAgentTier === "dedicated" ||
                            newAgentFlavor === "custom"
                          ) {
                            createBody.dockerImage =
                              newAgentDockerImage.trim() ||
                              "ghcr.io/elizaos/eliza:stable";
                          }

                          const res = await api<{
                            success: boolean;
                            created?: boolean;
                            data?: {
                              id?: string;
                              agentId?: string;
                              sandboxId?: string;
                            };
                          }>("/api/v1/eliza/agents", {
                            method: "POST",
                            json: createBody,
                          });

                          if (res?.success) {
                            const newId =
                              res.data?.id ??
                              res.data?.agentId ??
                              res.data?.sandboxId;
                            await agentsQuery.refetch();
                            if (newId) {
                              setSelectedItem(newId);
                            } else {
                              setSelectedItem(null);
                            }
                            setNewAgentName("");
                            setNewAgentFlavor("eliza");
                            setNewAgentTier("shared");
                          } else {
                            throw new Error("Failed to deploy agent");
                          }
                        } catch (err) {
                          setDeployError(
                            err instanceof Error ? err.message : String(err),
                          );
                        } finally {
                          setIsDeployingAgent(false);
                        }
                      }}
                      className="w-full mt-2 py-2 bg-[#FF5800] text-black font-bold rounded-xl hover:bg-[#ff7426] transition-all disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer shadow-[0_0_12px_rgba(255,88,0,0.2)] hover:shadow-[0_0_16px_rgba(255,88,0,0.35)]"
                    >
                      {isDeployingAgent ? (
                        <>
                          <RefreshCw className="h-4 w-4 animate-spin" />
                          Deploying Instance...
                        </>
                      ) : (
                        "Deploy Agent Instance"
                      )}
                    </button>
                  </div>

                  {/* Right Panel: Environment Variables */}
                  <div className="flex-1 flex flex-col min-w-0 pr-2 text-left">
                    <div className="flex justify-between items-center mb-3">
                      <span className="text-[10px] font-bold font-mono tracking-widest text-white/30 uppercase">
                        Environment Variables & Secrets
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setNewAgentEnvVars((prev) => [
                            ...prev,
                            { key: "", value: "" },
                          ]);
                        }}
                        className="px-2 py-1 bg-white/5 border border-white/10 rounded-lg text-white/70 hover:text-white hover:bg-white/10 flex items-center gap-1 cursor-pointer transition-colors"
                      >
                        <Plus className="h-3 w-3" />
                        Add Variable
                      </button>
                    </div>

                    <div className="flex-1 overflow-y-auto border border-white/5 rounded-xl bg-black/20 p-4 flex flex-col gap-3 max-h-[360px]">
                      {newAgentEnvVars.length === 0 ? (
                        <div className="text-white/30 text-center py-8">
                          No variables configured. Click "+ Add Variable" to
                          define keys and secrets.
                        </div>
                      ) : (
                        newAgentEnvVars.map((pair, idx) => (
                          <div
                            key={idx}
                            className="flex gap-3 items-end group/var"
                          >
                            <div className="flex-1 flex flex-col gap-1">
                              <label className="font-mono text-[8px] text-white/20 uppercase font-bold font-mono">
                                Key Name
                              </label>
                              <input
                                type="text"
                                placeholder="e.g. OPENAI_API_KEY"
                                value={pair.key}
                                onChange={(e) => {
                                  const updated = [...newAgentEnvVars];
                                  updated[idx].key =
                                    e.target.value.toUpperCase();
                                  setNewAgentEnvVars(updated);
                                }}
                                className="bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-white outline-none focus:border-[#FF5800]/50 font-mono text-xs"
                              />
                            </div>
                            <div className="flex-1 flex flex-col gap-1">
                              <label className="font-mono text-[8px] text-white/20 uppercase font-bold font-mono">
                                Value
                              </label>
                              <input
                                type="password"
                                placeholder="••••••••"
                                value={pair.value}
                                onChange={(e) => {
                                  const updated = [...newAgentEnvVars];
                                  updated[idx].value = e.target.value;
                                  setNewAgentEnvVars(updated);
                                }}
                                className="bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-white outline-none focus:border-[#FF5800]/50 font-mono text-xs"
                              />
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                setNewAgentEnvVars((prev) =>
                                  prev.filter((_, i) => i !== idx),
                                );
                              }}
                              className="p-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 hover:text-rose-300 border border-rose-500/20 rounded-lg transition-colors cursor-pointer"
                              title="Remove Variable"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-white/40 text-center py-20">
                Select an agent instance from the sidebar.
              </div>
            )}
          </div>
        </div>
      );
    }

    case "billing": {
      return (
        <div className="w-full h-full flex gap-6 text-left select-text p-2 animate-fade-up">
          {/* Left Panel */}
          <div className="w-72 shrink-0 flex flex-col gap-4 border-r border-white/10 pr-6">
            <span className="text-[10px] font-bold font-mono tracking-widest text-white/30 uppercase">
              Credits Wallet
            </span>
            {/* Credit Card Mock */}
            <div className="w-full h-36 rounded-xl relative overflow-hidden bg-gradient-to-br from-indigo-500/20 via-purple-500/10 to-pink-500/20 border border-white/10 shadow-[0_12px_24px_rgba(0,0,0,0.5)] flex flex-col justify-between p-4 text-left">
              <div className="absolute inset-0 bg-radial-gradient(circle at 10% 20%, rgba(255,88,0,0.1) 0%, transparent 60%)" />
              <div className="flex justify-between items-start z-10">
                <span className="text-[10px] font-mono tracking-widest text-white/40 uppercase">
                  Eliza Cloud Credits
                </span>
                <CreditCard className="h-4 w-4 text-indigo-400" />
              </div>
              <div className="z-10">
                <span className="text-3xl font-bold tracking-tight text-white">
                  ${Number(balance).toFixed(2)}
                </span>
                <p className="text-[8px] font-mono text-emerald-400 uppercase tracking-widest mt-1">
                  ● Wallet Active
                </p>
              </div>
            </div>

            {/* Quick Recharge */}
            <div className="flex flex-col gap-2 text-xs">
              <span className="text-[9px] font-bold font-mono text-white/30 uppercase">
                Auto Recharge
              </span>
              <div className="flex justify-between items-center bg-white/[0.01] border border-white/[0.04] p-3 rounded-xl">
                <div>
                  <p className="font-semibold text-white">Enable Auto-Topup</p>
                  <p className="text-[9px] text-white/40 mt-0.5">
                    Topup $50 when balance is below $10
                  </p>
                </div>
                <input
                  type="checkbox"
                  defaultChecked
                  className="w-4 h-4 rounded border-white/10 accent-[#FF5800]"
                />
              </div>
            </div>
            {/* Buy Credits */}
            <div className="flex flex-col gap-2 text-xs border-t border-white/5 pt-3">
              <span className="text-[9px] font-bold font-mono text-white/30 uppercase">
                Buy Credits (Stripe)
              </span>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <span className="absolute left-3 top-2.5 text-white/40 font-mono">
                    $
                  </span>
                  <input
                    type="number"
                    min="1"
                    max="10000"
                    value={rechargeAmount}
                    onChange={(e) => setRechargeAmount(e.target.value)}
                    className="w-full bg-black/40 border border-white/10 rounded-xl pl-7 pr-3 py-2 text-white outline-none focus:border-[#FF5800]/50 font-mono"
                    placeholder="50"
                  />
                </div>
                <button
                  type="button"
                  disabled={isCreatingCheckout}
                  onClick={handleStripeCheckout}
                  className="px-4 py-2 bg-[#FF5800] disabled:bg-[#FF5800]/50 text-black font-bold text-xs rounded-xl hover:bg-[#ff7426] disabled:cursor-not-allowed transition-all active:scale-[0.98] cursor-pointer"
                >
                  {isCreatingCheckout ? "Wait..." : "Pay"}
                </button>
              </div>
            </div>
          </div>

          {/* Right Panel - Detailed Tables */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="flex gap-1.5 border-b border-white/5 pb-2 mb-4 text-xs font-mono">
              {["ledger", "invoices", "projections"].map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={`tab-btn px-3 py-1 rounded transition-colors uppercase tracking-wider text-[10px] ${
                    activeTab === tab
                      ? "bg-white/10 text-white font-semibold"
                      : "text-white/40 hover:text-white/70 hover:bg-white/5"
                  }`}
                >
                  {tab === "ledger" ? "Transactions" : tab}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto text-xs">
              {activeTab === "ledger" && (
                <div className="flex flex-col gap-1.5">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b border-white/5 text-left text-[10px] font-mono text-white/30 uppercase">
                        <th className="pb-2 font-medium">Tx ID</th>
                        <th className="pb-2 font-medium">Description</th>
                        <th className="pb-2 font-medium text-right">Amount</th>
                        <th className="pb-2 font-medium text-right">Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.02] font-mono">
                      {transactions.map((tx) => (
                        <tr key={tx.id} className="hover:bg-white/[0.01]">
                          <td className="py-2.5 font-bold text-[#FF5800]/80">
                            {tx.id}
                          </td>
                          <td className="py-2.5 text-white/70">{tx.desc}</td>
                          <td
                            className={`py-2.5 text-right font-semibold ${tx.amt > 0 ? "text-emerald-400" : "text-rose-400"}`}
                          >
                            {tx.amt > 0
                              ? `+$${tx.amt.toFixed(2)}`
                              : `-$${Math.abs(tx.amt).toFixed(2)}`}
                          </td>
                          <td className="py-2.5 text-right text-white/40">
                            {tx.date}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {activeTab === "invoices" && (
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-white/5 text-left text-[10px] font-mono text-white/30 uppercase">
                      <th className="pb-2 font-medium">Invoice Number</th>
                      <th className="pb-2 font-medium">Date</th>
                      <th className="pb-2 font-medium">Amount</th>
                      <th className="pb-2 font-medium">Status</th>
                      <th className="pb-2 font-medium text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.02] font-mono">
                    {loadingInvoices ? (
                      <tr>
                        <td
                          colSpan={5}
                          className="py-8 text-center text-white/50 animate-pulse font-mono text-[10px] uppercase tracking-wider"
                        >
                          Loading Invoices...
                        </td>
                      </tr>
                    ) : realInvoices.length === 0 ? (
                      <tr>
                        <td
                          colSpan={5}
                          className="py-8 text-center text-white/30 font-mono"
                        >
                          No invoices found.
                        </td>
                      </tr>
                    ) : (
                      realInvoices.map((inv) => (
                        <tr key={inv.id} className="hover:bg-white/[0.01]">
                          <td className="py-2.5 text-white/80">{inv.id}</td>
                          <td className="py-2.5 text-white/40">{inv.date}</td>
                          <td className="py-2.5 font-semibold text-white/90">
                            {inv.total}
                          </td>
                          <td className="py-2.5">
                            <span
                              className={`text-[9px] uppercase font-bold px-1.5 py-0.5 rounded border ${
                                inv.status?.toLowerCase() === "paid"
                                  ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                                  : "text-amber-400 bg-amber-500/10 border-amber-500/20"
                              }`}
                            >
                              {inv.status}
                            </span>
                          </td>
                          <td className="py-2.5 text-right">
                            {inv.invoicePdf || inv.invoiceUrl ? (
                              <a
                                href={inv.invoicePdf || inv.invoiceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[#FF5800] hover:text-[#ff7426] font-semibold underline"
                              >
                                PDF
                              </a>
                            ) : (
                              <span className="text-white/20">—</span>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              )}

              {activeTab === "projections" && (
                <div className="bg-white/[0.01] border border-white/[0.04] rounded-xl p-4 flex flex-col gap-3 font-sans">
                  <h4 className="font-semibold text-white/90 text-sm">
                    Monthly Expenditure Estimations
                  </h4>
                  <p className="text-white/50 text-[11px] leading-relaxed">
                    Based on your current 3 active agent instances running, your
                    projected credit consumption is:
                  </p>
                  <div className="grid grid-cols-3 gap-3 text-center mt-2 font-mono">
                    <div className="bg-black/20 p-3 rounded-lg border border-white/5">
                      <p className="text-[9px] text-white/40 uppercase">
                        Daily Rate
                      </p>
                      <p className="text-base font-bold text-sky-400 mt-1">
                        $4.25
                      </p>
                    </div>
                    <div className="bg-black/20 p-3 rounded-lg border border-white/5">
                      <p className="text-[9px] text-white/40 uppercase">
                        Weekly Projection
                      </p>
                      <p className="text-base font-bold text-indigo-400 mt-1">
                        $29.75
                      </p>
                    </div>
                    <div className="bg-black/20 p-3 rounded-lg border border-white/5">
                      <p className="text-[9px] text-white/40 uppercase">
                        30-Day Total
                      </p>
                      <p className="text-base font-bold text-[#FF5800] mt-1">
                        $127.50
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }

    case "apikeys": {
      return (
        <div className="w-full h-full flex flex-col gap-4 text-left select-text p-2 animate-fade-up">
          {/* Sub-tabs header */}
          <div className="flex border-b border-white/5 pb-2 gap-4">
            <button
              type="button"
              onClick={() => setApiKeysSubTab("cloud-keys")}
              className={`tab-btn pb-1 text-xs font-bold font-mono uppercase tracking-wider border-b-2 cursor-pointer transition-colors ${
                apiKeysSubTab === "cloud-keys"
                  ? "border-[#FF5800] text-white"
                  : "border-transparent text-white/40 hover:text-white"
              }`}
            >
              Eliza Cloud Keys
            </button>
            <button
              type="button"
              onClick={() => setApiKeysSubTab("provider-secrets")}
              className={`tab-btn pb-1 text-xs font-bold font-mono uppercase tracking-wider border-b-2 cursor-pointer transition-colors ${
                apiKeysSubTab === "provider-secrets"
                  ? "border-[#FF5800] text-white"
                  : "border-transparent text-white/40 hover:text-white"
              }`}
            >
              Provider Secrets & External Keys
            </button>
          </div>

          {apiKeysSubTab === "cloud-keys" ? (
            <div className="w-full flex-1 flex gap-6 min-h-0">
              {/* Left Panel - Create Key */}
              <div className="w-72 shrink-0 flex flex-col gap-4 border-r border-white/10 pr-6">
                <span className="text-[10px] font-bold font-mono tracking-widest text-white/30 uppercase">
                  Generate New API Key
                </span>
                <div className="flex flex-col gap-3 text-xs">
                  <div className="flex flex-col gap-1.5">
                    <label className="font-mono text-[9px] text-white/40 uppercase font-bold">
                      Key Label Name
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. Eliza Prod Agent"
                      value={newKeyName}
                      onChange={(e) => setNewKeyName(e.target.value)}
                      className="bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-white outline-none focus:border-[#FF5800]/50"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={async () => {
                      if (!newKeyName.trim()) return;
                      const res = await api<{
                        apiKey: ApiKeyRecord;
                        plainKey: string;
                      }>("/api/v1/api-keys", {
                        method: "POST",
                        json: { name: newKeyName },
                      });
                      if (res?.plainKey) {
                        setGeneratedPlainKey(res.plainKey);
                      }
                      setNewKeyName("");
                      apiKeysQuery.refetch();
                    }}
                    className="w-full py-2 bg-[#FF5800] text-black font-bold text-xs rounded-xl hover:bg-[#ff7426] transition-all cursor-pointer"
                  >
                    Generate API Key
                  </button>
                </div>
              </div>

              {/* Right Panel - Detailed Keys List */}
              <div className="flex-1 flex flex-col min-w-0">
                <span className="text-[10px] font-bold font-mono tracking-widest text-white/30 uppercase mb-3">
                  API Access Keys
                </span>
                <div className="flex-1 overflow-y-auto text-xs">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b border-white/5 text-left text-[10px] font-mono text-white/30 uppercase">
                        <th className="pb-2 font-medium">Name</th>
                        <th className="pb-2 font-medium">Token Prefix</th>
                        <th className="pb-2 font-medium">Usage</th>
                        <th className="pb-2 font-medium">Rate Limit</th>
                        <th className="pb-2 font-medium">Status</th>
                        <th className="pb-2 font-medium text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.02] font-mono">
                      {apiKeys.length === 0 ? (
                        <tr>
                          <td
                            colSpan={7}
                            className="py-4 text-center text-white/30"
                          >
                            No API Keys created yet.
                          </td>
                        </tr>
                      ) : (
                        apiKeys.map((k) => (
                          <tr key={k.id} className="hover:bg-white/[0.01]">
                            <td className="py-2.5">
                              {editingKeyId === k.id ? (
                                <div className="flex items-center gap-1.5">
                                  <input
                                    type="text"
                                    value={editingKeyName}
                                    onChange={(e) =>
                                      setEditingKeyName(e.target.value)
                                    }
                                    className="bg-black/60 border border-white/20 rounded px-2 py-0.5 text-xs text-white outline-none focus:border-[#FF5800]/50 font-sans"
                                    onKeyDown={async (e) => {
                                      if (e.key === "Enter") {
                                        if (!editingKeyName.trim()) return;
                                        await api(`/api/v1/api-keys/${k.id}`, {
                                          method: "PATCH",
                                          json: {
                                            name: editingKeyName,
                                          },
                                        });
                                        setEditingKeyId(null);
                                        apiKeysQuery.refetch();
                                      } else if (e.key === "Escape") {
                                        setEditingKeyId(null);
                                      }
                                    }}
                                  />
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      if (!editingKeyName.trim()) return;
                                      await api(`/api/v1/api-keys/${k.id}`, {
                                        method: "PATCH",
                                        json: {
                                          name: editingKeyName,
                                        },
                                      });
                                      setEditingKeyId(null);
                                      apiKeysQuery.refetch();
                                    }}
                                    className="p-1 hover:bg-white/5 rounded text-emerald-400 font-bold cursor-pointer"
                                  >
                                    ✓
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setEditingKeyId(null)}
                                    className="p-1 hover:bg-white/5 rounded text-rose-400 font-bold cursor-pointer"
                                  >
                                    ✕
                                  </button>
                                </div>
                              ) : (
                                <div className="flex items-center gap-2 group">
                                  <span className="font-bold text-white/80">
                                    {k.name}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingKeyId(k.id);
                                      setEditingKeyName(k.name);
                                    }}
                                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-white/5 rounded text-white/40 hover:text-white transition-opacity cursor-pointer"
                                    title="Edit Name"
                                  >
                                    <svg
                                      className="w-3 h-3"
                                      fill="none"
                                      viewBox="0 0 24 24"
                                      stroke="currentColor"
                                      strokeWidth="2.5"
                                      role="img"
                                      aria-label="Edit Name"
                                    >
                                      <title>Edit Name</title>
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                                      />
                                    </svg>
                                  </button>
                                </div>
                              )}
                            </td>
                            <td className="py-2.5 text-white/40">
                              eliza_live_••••{k.token?.slice(-4) || "4a2b"}
                            </td>
                            <td className="py-2.5 text-white/70">
                              {Number(k.usage_count || 0).toLocaleString()}{" "}
                              calls
                            </td>
                            <td className="py-2.5 text-white/50">
                              {Number(k.rate_limit || 1000).toLocaleString()}{" "}
                              req/min
                            </td>
                            <td className="py-2.5">
                              <button
                                type="button"
                                onClick={async () => {
                                  await api(`/api/v1/api-keys/${k.id}`, {
                                    method: "PATCH",
                                    json: {
                                      is_active: !k.is_active,
                                    },
                                  });
                                  apiKeysQuery.refetch();
                                }}
                                className={`px-2 py-0.5 rounded text-[10px] font-bold border transition-colors cursor-pointer ${
                                  k.is_active
                                    ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25"
                                    : "bg-zinc-500/10 border-zinc-500/30 text-zinc-400 hover:bg-zinc-500/25"
                                }`}
                              >
                                {k.is_active ? "Active" : "Inactive"}
                              </button>
                            </td>
                            <td className="py-2.5 text-right flex gap-1.5 justify-end">
                              <button
                                type="button"
                                onClick={() => {
                                  navigator.clipboard.writeText(
                                    k.token || "mock-token-copied",
                                  );
                                  alert("Key copied to clipboard!");
                                }}
                                className="px-2 py-0.5 bg-white/5 border border-white/10 rounded hover:bg-white/10 text-white/60 hover:text-white cursor-pointer"
                              >
                                Copy
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  await api(`/api/v1/api-keys/${k.id}`, {
                                    method: "DELETE",
                                  });
                                  apiKeysQuery.refetch();
                                }}
                                className="px-2 py-0.5 bg-rose-500/10 border border-rose-500/20 rounded hover:bg-rose-500/20 text-rose-400 cursor-pointer"
                              >
                                Revoke
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : (
            <div className="w-full flex-1 flex gap-6 min-h-0">
              {/* Left Panel - Add Provider Secret */}
              <div className="w-72 shrink-0 flex flex-col gap-4 border-r border-white/10 pr-6">
                <span className="text-[10px] font-bold font-mono tracking-widest text-white/30 uppercase">
                  Save Provider Secret
                </span>
                <div className="flex flex-col gap-3 text-xs">
                  <div className="flex flex-col gap-1.5">
                    <label className="font-mono text-[9px] text-white/40 uppercase font-bold">
                      Key Provider
                    </label>
                    <select
                      value={newExtKeyProvider}
                      onChange={(e) => {
                        const prov = e.target.value;
                        setNewExtKeyProvider(prov);
                        // Auto-fill key name template if empty or if matching prior prefix
                        if (
                          !newExtKeyName.trim() ||
                          newExtKeyName.endsWith("_KEY") ||
                          newExtKeyName.endsWith("_TOKEN") ||
                          newExtKeyName.endsWith("_USERNAME")
                        ) {
                          if (prov === "openai")
                            setNewExtKeyName("OPENAI_API_KEY");
                          else if (prov === "anthropic")
                            setNewExtKeyName("ANTHROPIC_API_KEY");
                          else if (prov === "discord")
                            setNewExtKeyName("DISCORD_TOKEN");
                          else if (prov === "twitter")
                            setNewExtKeyName("TWITTER_USERNAME");
                          else if (prov === "telegram")
                            setNewExtKeyName("TELEGRAM_BOT_TOKEN");
                          else if (prov === "elevenlabs")
                            setNewExtKeyName("ELEVENLABS_API_KEY");
                          else if (prov === "fal")
                            setNewExtKeyName("FAL_API_KEY");
                          else setNewExtKeyName("");
                        }
                      }}
                      className="bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-white outline-none focus:border-[#FF5800]/50"
                    >
                      <option value="openai">OpenAI</option>
                      <option value="anthropic">Anthropic</option>
                      <option value="discord">Discord</option>
                      <option value="twitter">Twitter / X</option>
                      <option value="telegram">Telegram</option>
                      <option value="elevenlabs">ElevenLabs</option>
                      <option value="fal">Fal AI</option>
                      <option value="custom">Custom Provider</option>
                    </select>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="font-mono text-[9px] text-white/40 uppercase font-bold">
                      Secret Name / Env Var
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. OPENAI_API_KEY"
                      value={newExtKeyName}
                      onChange={(e) => setNewExtKeyName(e.target.value)}
                      className="bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-white outline-none focus:border-[#FF5800]/50 font-mono"
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="font-mono text-[9px] text-white/40 uppercase font-bold">
                      Secret Key Value
                    </label>
                    <input
                      type="password"
                      placeholder="Paste API Key / Token"
                      value={newExtKeyValue}
                      onChange={(e) => setNewExtKeyValue(e.target.value)}
                      className="bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-white outline-none focus:border-[#FF5800]/50 font-mono"
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="font-mono text-[9px] text-white/40 uppercase font-bold">
                      Description / Context
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. Production runtime inferences"
                      value={newExtKeyDesc}
                      onChange={(e) => setNewExtKeyDesc(e.target.value)}
                      className="bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-white outline-none focus:border-[#FF5800]/50"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      if (!newExtKeyName.trim() || !newExtKeyValue.trim())
                        return;
                      const saveSecret = async () => {
                        try {
                          const res = await api<{ secret: SecretRecord }>(
                            "/api/v1/secrets",
                            {
                              method: "POST",
                              json: {
                                name: newExtKeyName,
                                provider: newExtKeyProvider,
                                value: newExtKeyValue,
                                description: newExtKeyDesc || undefined,
                              },
                            },
                          );
                          if (res?.secret) {
                            const mapped: ExternalKeyRecord = {
                              id: res.secret.id,
                              name: res.secret.name,
                              provider: res.secret.provider || "custom",
                              value: "••••••••••••••••",
                              is_active: true,
                              created_at:
                                res.secret.createdAt ||
                                new Date().toISOString(),
                              description: res.secret.description || undefined,
                            };
                            setExternalKeys((prev) => {
                              const existingIdx = prev.findIndex(
                                (x) => x.name === mapped.name,
                              );
                              if (existingIdx !== -1) {
                                const updated = [...prev];
                                updated[existingIdx] = mapped;
                                return updated;
                              }
                              return [mapped, ...prev];
                            });
                            setNewExtKeyName("");
                            setNewExtKeyValue("");
                            setNewExtKeyDesc("");
                          }
                        } catch (e) {
                          console.error("Save secret error", e);
                          alert(
                            e instanceof Error
                              ? e.message
                              : "Failed to save secret",
                          );
                        }
                      };
                      saveSecret();
                    }}
                    className="w-full py-2 bg-[#FF5800] text-black font-bold text-xs rounded-xl hover:bg-[#ff7426] transition-all cursor-pointer"
                  >
                    Save Secret Key
                  </button>
                </div>
              </div>

              {/* Right Panel - Provider Secrets List */}
              <div className="flex-1 flex flex-col min-w-0">
                <span className="text-[10px] font-bold font-mono tracking-widest text-white/30 uppercase mb-3">
                  Stored Third-Party Secrets
                </span>
                <div className="flex-1 overflow-y-auto text-xs">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b border-white/5 text-left text-[10px] font-mono text-white/30 uppercase">
                        <th className="pb-2 font-medium">Provider</th>
                        <th className="pb-2 font-medium">
                          Secret Variable Name
                        </th>
                        <th className="pb-2 font-medium">Value</th>
                        <th className="pb-2 font-medium">Description</th>
                        <th className="pb-2 font-medium">Status</th>
                        <th className="pb-2 font-medium text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.02] font-mono">
                      {externalKeys.length === 0 ? (
                        <tr>
                          <td
                            colSpan={6}
                            className="py-4 text-center text-white/30"
                          >
                            No Provider secrets saved yet.
                          </td>
                        </tr>
                      ) : (
                        externalKeys.map((k: ExternalKeyRecord) => (
                          <tr key={k.id} className="hover:bg-white/[0.01]">
                            <td className="py-2.5">
                              <span
                                className={`text-[9px] px-1.5 py-0.5 rounded border uppercase font-bold ${
                                  k.provider === "openai"
                                    ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                                    : k.provider === "anthropic"
                                      ? "bg-amber-500/10 border-amber-500/20 text-amber-400"
                                      : k.provider === "discord"
                                        ? "bg-indigo-500/10 border-indigo-500/20 text-indigo-400"
                                        : k.provider === "twitter"
                                          ? "bg-sky-500/10 border-sky-500/20 text-sky-400"
                                          : k.provider === "telegram"
                                            ? "bg-blue-500/10 border-blue-500/20 text-blue-400"
                                            : k.provider === "elevenlabs"
                                              ? "bg-teal-500/10 border-teal-500/20 text-teal-400"
                                              : k.provider === "fal"
                                                ? "bg-pink-500/10 border-pink-500/20 text-pink-400"
                                                : "bg-white/5 border-white/10 text-white/60"
                                }`}
                              >
                                {k.provider}
                              </span>
                            </td>
                            <td className="py-2.5 font-bold text-white/80">
                              {editingExtKeyId === k.id ? (
                                <input
                                  type="text"
                                  value={editingExtKeyName}
                                  onChange={(e) =>
                                    setEditingExtKeyName(e.target.value)
                                  }
                                  className="bg-black/60 border border-white/20 rounded px-2 py-0.5 text-xs text-white outline-none focus:border-[#FF5800]/50 font-mono"
                                />
                              ) : (
                                k.name
                              )}
                            </td>
                            <td className="py-2.5 font-mono">
                              {editingExtKeyId === k.id ? (
                                <input
                                  type="text"
                                  value={editingExtKeyValue}
                                  onChange={(e) =>
                                    setEditingExtKeyValue(e.target.value)
                                  }
                                  className="bg-black/60 border border-white/20 rounded px-2 py-0.5 text-xs text-white outline-none focus:border-[#FF5800]/50 font-mono"
                                />
                              ) : showExtKeyIds[k.id] ? (
                                <span className="text-white/95">{k.value}</span>
                              ) : (
                                <span className="text-white/30">
                                  {k.value.length > 25
                                    ? `${k.value.slice(0, 8)}••••••••••••••••`
                                    : "••••••••••••••••"}
                                </span>
                              )}
                            </td>
                            <td className="py-2.5 text-white/50 max-w-[150px] truncate">
                              {editingExtKeyId === k.id ? (
                                <input
                                  type="text"
                                  value={editingExtKeyDesc}
                                  onChange={(e) =>
                                    setEditingExtKeyDesc(e.target.value)
                                  }
                                  className="bg-black/60 border border-white/20 rounded px-2 py-0.5 text-xs text-white outline-none focus:border-[#FF5800]/50 font-sans"
                                />
                              ) : (
                                k.description || "-"
                              )}
                            </td>
                            <td className="py-2.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setExternalKeys((prev) =>
                                    prev.map((item) =>
                                      item.id === k.id
                                        ? {
                                            ...item,
                                            is_active: !item.is_active,
                                          }
                                        : item,
                                    ),
                                  );
                                }}
                                className={`px-2 py-0.5 rounded text-[10px] font-bold border transition-colors cursor-pointer ${
                                  k.is_active
                                    ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25"
                                    : "bg-zinc-500/10 border-zinc-500/30 text-zinc-400 hover:bg-zinc-500/25"
                                }`}
                              >
                                {k.is_active ? "Active" : "Inactive"}
                              </button>
                            </td>
                            <td className="py-2.5 text-right flex gap-1.5 justify-end items-center">
                              {editingExtKeyId === k.id ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (
                                        !editingExtKeyName.trim() ||
                                        !editingExtKeyValue.trim()
                                      )
                                        return;
                                      const saveEdit = async () => {
                                        try {
                                          const res = await api<{
                                            secret: SecretRecord;
                                          }>(`/api/v1/secrets/${k.id}`, {
                                            method: "PATCH",
                                            json: {
                                              name: editingExtKeyName,
                                              value:
                                                editingExtKeyValue !==
                                                "••••••••••••••••"
                                                  ? editingExtKeyValue
                                                  : undefined,
                                              description:
                                                editingExtKeyDesc || undefined,
                                              provider: editingExtKeyProvider,
                                            },
                                          });
                                          if (res?.secret) {
                                            setExternalKeys((prev) =>
                                              prev.map((item) =>
                                                item.id === k.id
                                                  ? {
                                                      ...item,
                                                      name: res.secret.name,
                                                      value:
                                                        editingExtKeyValue !==
                                                        "••••••••••••••••"
                                                          ? editingExtKeyValue
                                                          : item.value,
                                                      description:
                                                        res.secret
                                                          .description ||
                                                        undefined,
                                                      provider:
                                                        res.secret.provider ||
                                                        item.provider,
                                                    }
                                                  : item,
                                              ),
                                            );
                                            setEditingExtKeyId(null);
                                          }
                                        } catch (e) {
                                          console.error("Edit secret error", e);
                                          alert(
                                            e instanceof Error
                                              ? e.message
                                              : "Failed to edit secret",
                                          );
                                        }
                                      };
                                      saveEdit();
                                    }}
                                    className="p-1 hover:bg-white/5 rounded text-emerald-400 font-bold cursor-pointer"
                                    title="Save changes"
                                  >
                                    <Check className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setEditingExtKeyId(null)}
                                    className="p-1 hover:bg-white/5 rounded text-rose-400 font-bold cursor-pointer"
                                    title="Cancel"
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const isCurrentlyShown =
                                        showExtKeyIds[k.id];
                                      if (!isCurrentlyShown) {
                                        const fetchVal = async () => {
                                          try {
                                            const res = await api<{
                                              value: string;
                                            }>(`/api/v1/secrets/${k.id}/value`);
                                            if (res?.value) {
                                              setExternalKeys((prev) =>
                                                prev.map((item) =>
                                                  item.id === k.id
                                                    ? {
                                                        ...item,
                                                        value: res.value,
                                                      }
                                                    : item,
                                                ),
                                              );
                                              setShowExtKeyIds((prev) => ({
                                                ...prev,
                                                [k.id]: true,
                                              }));
                                            }
                                          } catch (e) {
                                            console.error(
                                              "Fetch secret value error",
                                              e,
                                            );
                                          }
                                        };
                                        fetchVal();
                                      } else {
                                        setShowExtKeyIds((prev) => ({
                                          ...prev,
                                          [k.id]: false,
                                        }));
                                      }
                                    }}
                                    className="p-1 rounded hover:bg-white/5 text-white/40 hover:text-white cursor-pointer"
                                    title={
                                      showExtKeyIds[k.id]
                                        ? "Hide Secret"
                                        : "Show Secret"
                                    }
                                  >
                                    {showExtKeyIds[k.id] ? (
                                      <EyeOff className="h-3.5 w-3.5" />
                                    ) : (
                                      <Eye className="h-3.5 w-3.5" />
                                    )}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const copyVal = async () => {
                                        try {
                                          let valToCopy = k.value;
                                          if (
                                            valToCopy.startsWith("•••") ||
                                            valToCopy === "••••••••••••••••"
                                          ) {
                                            const res = await api<{
                                              value: string;
                                            }>(`/api/v1/secrets/${k.id}/value`);
                                            if (res?.value) {
                                              valToCopy = res.value;
                                            }
                                          }
                                          await navigator.clipboard.writeText(
                                            valToCopy,
                                          );
                                          alert("Secret value copied!");
                                        } catch (e) {
                                          console.error(
                                            "Copy secret value error",
                                            e,
                                          );
                                        }
                                      };
                                      copyVal();
                                    }}
                                    className="p-1 rounded hover:bg-white/5 text-white/40 hover:text-white cursor-pointer"
                                    title="Copy Value"
                                  >
                                    <Copy className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingExtKeyId(k.id);
                                      setEditingExtKeyName(k.name);
                                      setEditingExtKeyProvider(k.provider);
                                      setEditingExtKeyValue(k.value);
                                      setEditingExtKeyDesc(k.description || "");
                                    }}
                                    className="p-1 rounded hover:bg-white/5 text-white/40 hover:text-white cursor-pointer"
                                    title="Edit Key"
                                  >
                                    <Edit3 className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const deleteSecret = async () => {
                                        try {
                                          const res = await api<{
                                            success: boolean;
                                          }>(`/api/v1/secrets/${k.id}`, {
                                            method: "DELETE",
                                          });
                                          if (res?.success) {
                                            setExternalKeys((prev) =>
                                              prev.filter(
                                                (item) => item.id !== k.id,
                                              ),
                                            );
                                          }
                                        } catch (e) {
                                          console.error(
                                            "Delete secret error",
                                            e,
                                          );
                                        }
                                      };
                                      deleteSecret();
                                    }}
                                    className="p-1 rounded hover:bg-white/5 text-rose-400 hover:bg-rose-500/10 cursor-pointer"
                                    title="Revoke / Delete"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </>
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      );
    }

    case "analytics": {
      const runningAgents = agents.filter((a) => a.status === "running").length;
      const totalAgents = agents.length;
      const utilPct =
        totalAgents > 0 ? Math.round((runningAgents / totalAgents) * 100) : 0;
      const activeKeyCount = Array.isArray(apiKeysQuery?.data)
        ? apiKeysQuery.data.filter((k) => k.is_active).length
        : 0;
      const creditBal = typeof creditBalance === "number" ? creditBalance : 0;
      // Seed bar heights from agent statuses for a dynamic but deterministic chart
      const barSeed =
        agents.length > 0
          ? agents.map((_agent, i) => 30 + ((i * 37 + 17) % 60))
          : [20, 35, 60, 45, 50, 75, 90, 80, 65, 55, 40, 60, 85, 95, 70];
      return (
        <div className="w-full h-full flex flex-col text-left select-text p-2 animate-fade-up">
          <span className="text-[10px] font-bold font-mono tracking-widest text-white/30 uppercase mb-3">
            System Performance Metrics
          </span>

          {/* Top Gauges row */}
          <div className="grid grid-cols-4 gap-4 mb-6">
            <div className="bg-white/[0.01] border border-white/[0.04] rounded-xl p-4 flex flex-col justify-center items-center text-center">
              <span className="text-[9px] font-mono text-white/40 uppercase">
                Agent Utilization
              </span>
              <span className="text-xl font-bold text-sky-400 mt-1">
                {utilPct}%
              </span>
              <span
                className={`text-[8px] font-mono mt-0.5 ${utilPct > 50 ? "text-emerald-400" : "text-amber-400"}`}
              >
                ● {runningAgents}/{totalAgents} active
              </span>
            </div>
            <div className="bg-white/[0.01] border border-white/[0.04] rounded-xl p-4 flex flex-col justify-center items-center text-center">
              <span className="text-[9px] font-mono text-white/40 uppercase">
                Credit Balance
              </span>
              <span className="text-xl font-bold text-indigo-400 mt-1">
                ${creditBal.toFixed(2)}
              </span>
              <span className="text-[8px] font-mono text-white/20 mt-0.5">
                available credits
              </span>
            </div>
            <div className="bg-white/[0.01] border border-white/[0.04] rounded-xl p-4 flex flex-col justify-center items-center text-center">
              <span className="text-[9px] font-mono text-white/40 uppercase">
                Active API Keys
              </span>
              <span className="text-xl font-bold text-[#FF5800] mt-1">
                {activeKeyCount}
              </span>
              <span className="text-[8px] font-mono text-white/30 mt-0.5">
                keys configured
              </span>
            </div>
            <div className="bg-white/[0.01] border border-white/[0.04] rounded-xl p-4 flex flex-col justify-center items-center text-center">
              <span className="text-[9px] font-mono text-white/40 uppercase">
                MCP Servers
              </span>
              <span className="text-xl font-bold text-emerald-400 mt-1">
                {realMcps.length}
              </span>
              <span className="text-[8px] font-mono text-white/20 mt-0.5">
                registered
              </span>
            </div>
          </div>

          {/* Graphical Charts */}
          <div className="flex-1 grid grid-cols-2 gap-6 min-h-0 text-xs">
            <div className="bg-white/[0.01] border border-white/[0.04] p-4 rounded-xl flex flex-col justify-between">
              <div className="flex justify-between items-center mb-3">
                <span className="font-semibold text-white/80">
                  Agent Activity Distribution
                </span>
                <span className="text-[9px] font-mono text-sky-400 bg-sky-500/10 border border-sky-500/20 px-1 rounded">
                  {runningAgents} running
                </span>
              </div>
              <div className="flex-1 flex gap-2.5 items-end justify-center px-4 pt-4 pb-2">
                {barSeed.slice(0, 15).map((h: number, i: number) => (
                  <div
                    key={`bar-sky-${i}-${h}`}
                    className="flex-1 bg-gradient-to-t from-sky-500/10 to-sky-400/80 rounded-t-sm transition-all duration-500"
                    style={{ height: `${h}%` }}
                  />
                ))}
              </div>
              <div className="flex justify-between text-[8px] font-mono text-white/30 mt-1">
                <span>00:00</span>
                <span>06:00</span>
                <span>12:00</span>
                <span>18:00</span>
                <span>24:00</span>
              </div>
            </div>

            <div className="bg-white/[0.01] border border-white/[0.04] p-4 rounded-xl flex flex-col justify-between">
              <div className="flex justify-between items-center mb-3">
                <span className="font-semibold text-white/80">
                  Credit & Resource Consumption
                </span>
                <span className="text-[9px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1 rounded">
                  ${creditBal.toFixed(2)} remaining
                </span>
              </div>
              <div className="flex-1 flex gap-2 items-end justify-center px-4 pt-4 pb-2">
                {barSeed.slice(0, 15).map((h: number, i: number) => (
                  <div
                    key={`bar-orange-${i}-${h}`}
                    className="flex-1 bg-gradient-to-t from-[#FF5800]/10 to-[#FF5800]/80 rounded-t-sm transition-all duration-500"
                    style={{ height: `${Math.max(10, 100 - h)}%` }}
                  />
                ))}
              </div>
              <div className="flex justify-between text-[8px] font-mono text-white/30 mt-1">
                <span>00:00</span>
                <span>06:00</span>
                <span>12:00</span>
                <span>18:00</span>
                <span>24:00</span>
              </div>
            </div>
          </div>
        </div>
      );
    }

    case "security": {
      return (
        <div className="w-full h-full flex gap-6 text-left select-text p-2 animate-fade-up">
          {/* Left panel - Config */}
          <div className="w-72 shrink-0 flex flex-col gap-4 border-r border-white/10 pr-6">
            <span className="text-[10px] font-bold font-mono tracking-widest text-white/30 uppercase">
              Security Configuration
            </span>

            {/* MFA Setup QR Mock */}
            <div className="bg-white/[0.01] border border-white/[0.04] rounded-xl p-4 flex flex-col items-center gap-3">
              <span className="text-[10px] font-bold font-mono text-white/40 uppercase">
                Two-Factor Authentication
              </span>
              {/* QR Code Graphic Placeholder */}
              <div className="w-32 h-32 bg-white rounded-lg p-2 flex items-center justify-center relative shadow-inner">
                <svg
                  width="100"
                  height="100"
                  viewBox="0 0 100 100"
                  className="text-black"
                  role="img"
                  aria-label="QR code"
                >
                  <title>QR code</title>
                  <rect width="25" height="25" fill="currentColor" />
                  <rect x="75" width="25" height="25" fill="currentColor" />
                  <rect y="75" width="25" height="25" fill="currentColor" />
                  <rect
                    x="30"
                    y="30"
                    width="40"
                    height="40"
                    fill="currentColor"
                  />
                  <rect
                    x="10"
                    y="40"
                    width="10"
                    height="20"
                    fill="currentColor"
                  />
                  <rect
                    x="80"
                    y="40"
                    width="10"
                    height="45"
                    fill="currentColor"
                  />
                  <rect
                    x="40"
                    y="80"
                    width="30"
                    height="10"
                    fill="currentColor"
                  />
                </svg>
              </div>
              <p className="text-[10px] text-center text-white/40">
                Scan with your Google Authenticator app to enable MFA
                verification codes.
              </p>
            </div>

            {/* Password Change Form */}
            <div className="flex flex-col gap-2.5 text-xs">
              <div className="flex flex-col gap-1">
                <label className="font-mono text-[9px] text-white/40 uppercase font-bold">
                  Update Master Password
                </label>
                <input
                  type="password"
                  placeholder="••••••••••••••"
                  className="bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-white outline-none focus:border-[#FF5800]/50"
                />
              </div>
              <button
                type="button"
                onClick={() => alert("Master Password Updated Successfully!")}
                className="w-full py-1.5 border border-[#FF5800]/30 hover:border-[#FF5800]/60 text-[#FF5800] hover:text-[#ff7426] bg-[#FF5800]/5 font-bold rounded-lg transition-colors"
              >
                Change Password
              </button>
            </div>
          </div>

          {/* Right Panel - Audit Logs */}
          <div className="flex-1 flex flex-col min-w-0">
            <span className="text-[10px] font-bold font-mono tracking-widest text-white/30 uppercase mb-3">
              Access Security Audit Event Logs
            </span>
            <div className="flex-1 overflow-y-auto text-[11px] font-mono">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-white/5 text-left text-[10px] font-mono text-white/30 uppercase">
                    <th className="pb-2 font-medium">Event Log</th>
                    <th className="pb-2 font-medium">User Profile</th>
                    <th className="pb-2 font-medium">IP Address</th>
                    <th className="pb-2 font-medium text-right">Timestamp</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.02]">
                  {loadingAuditLogs ? (
                    <tr>
                      <td
                        colSpan={4}
                        className="py-8 text-center text-white/50 animate-pulse font-mono text-[10px] uppercase tracking-wider"
                      >
                        Loading Audit Logs...
                      </td>
                    </tr>
                  ) : realAuditLogs.length === 0 ? (
                    <tr>
                      <td
                        colSpan={4}
                        className="py-8 text-center text-white/30"
                      >
                        No audit events recorded yet.
                      </td>
                    </tr>
                  ) : (
                    realAuditLogs.map((log) => (
                      <tr key={log.event_id} className="hover:bg-white/[0.01]">
                        <td className="py-2 text-white/80 font-sans font-medium">
                          <span className="flex items-center gap-1.5">
                            <span
                              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                log.result === "allow"
                                  ? "bg-emerald-400"
                                  : log.result === "deny"
                                    ? "bg-amber-400"
                                    : "bg-rose-400"
                              }`}
                            />
                            {log.action}
                          </span>
                        </td>
                        <td className="py-2 text-white/45">
                          {log.resource
                            ? `${log.resource.type}:${log.resource.id}`
                            : "Account"}
                        </td>
                        <td className="py-2 text-sky-400">
                          {log.ip || "unknown"}
                        </td>
                        <td className="py-2 text-right text-white/30">
                          {new Date(log.ts).toLocaleString()}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      );
    }

    case "connectors": {
      return (
        <div className="w-full h-full flex gap-6 text-left select-text p-2 animate-fade-up">
          {/* Left Panel */}
          <div className="w-64 shrink-0 flex flex-col gap-2 border-r border-white/10 pr-6">
            <span className="text-[10px] font-bold font-mono tracking-widest text-white/30 uppercase">
              Connected Channels
            </span>
            <div className="flex flex-col gap-1.5 flex-1 overflow-y-auto">
              {Object.entries(connectors).map(([platform, active]) => (
                <button
                  key={platform}
                  type="button"
                  onClick={() => setSelectedItem(platform)}
                  className={`w-full flex items-center justify-between p-3 rounded-xl border text-left transition-all ${
                    (selectedItem || "twitter") === platform
                      ? "bg-white/[0.04] border-[#FF5800]/50 shadow-[0_4px_12px_rgba(255,88,0,0.05)] text-white"
                      : "bg-transparent border-white/5 text-white/60 hover:bg-white/[0.02]"
                  }`}
                >
                  <span className="font-bold text-xs uppercase font-mono tracking-wider">
                    {platform}
                  </span>
                  <div
                    className={`w-2 h-2 rounded-full shrink-0 ${active ? "bg-emerald-400 shadow-[0_0_6px_#34d399]" : "bg-zinc-600"}`}
                  />
                </button>
              ))}
            </div>
          </div>

          {/* Right Panel */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="flex justify-between items-center border-b border-white/10 pb-4 mb-4">
              <h2 className="text-lg font-bold text-zinc-100 uppercase font-mono">
                {selectedItem || "twitter"} Connector Settings
              </h2>
              <button
                type="button"
                onClick={() => {
                  const plat = selectedItem || "twitter";
                  setConnectors((prev) => ({ ...prev, [plat]: !prev[plat] }));
                }}
                className={`px-3 py-1 rounded-lg text-xs font-bold border transition-colors ${
                  connectors[selectedItem || "twitter"]
                    ? "bg-rose-500/10 border-rose-500/30 text-rose-400 hover:bg-rose-500/25"
                    : "bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25"
                }`}
              >
                {connectors[selectedItem || "twitter"]
                  ? "Disconnect Channel"
                  : "Establish Link"}
              </button>
            </div>

            <div className="flex-1 overflow-y-auto text-xs flex flex-col gap-3.5 max-w-md">
              <div className="flex flex-col gap-1">
                <label className="font-mono text-[9px] text-white/40 uppercase font-bold">
                  Webhook Endpoints
                </label>
                <input
                  type="text"
                  readOnly
                  value={`https://api.eliza.cloud/v1/connectors/${selectedItem || "twitter"}/webhook`}
                  className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-white/50 font-mono select-all outline-none"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="font-mono text-[9px] text-white/40 uppercase font-bold">
                  API Access Token
                </label>
                <input
                  type="password"
                  value="••••••••••••••••••••••••••••"
                  className="bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-white outline-none focus:border-[#FF5800]/50"
                  onChange={() => {}}
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="font-mono text-[9px] text-white/40 uppercase font-bold">
                  Secret Key
                </label>
                <input
                  type="password"
                  value="••••••••••••••••••••••••••••"
                  className="bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-white outline-none focus:border-[#FF5800]/50"
                  onChange={() => {}}
                />
              </div>

              <button
                type="button"
                onClick={() => alert("Connector tokens updated successfully!")}
                className="w-full py-2 bg-[#FF5800] text-black font-bold rounded-lg hover:bg-[#ff7426] transition-all"
              >
                Save Integration Keys
              </button>
            </div>
          </div>
        </div>
      );
    }

    case "mcps": {
      return (
        <div className="w-full h-full flex gap-6 text-left select-text p-2 animate-fade-up">
          {/* Left Sidebar */}
          <div className="w-64 shrink-0 flex flex-col gap-2 border-r border-white/10 pr-6">
            <span className="text-[10px] font-bold font-mono tracking-widest text-white/30 uppercase">
              Model Context Protocol
            </span>
            <div className="flex flex-col gap-1.5 overflow-y-auto flex-1">
              {loadingMcps ? (
                <div className="text-white/40 text-[10px] font-mono animate-pulse uppercase tracking-wider py-4">
                  Loading servers...
                </div>
              ) : realMcps.length === 0 ? (
                <div className="text-white/30 text-[10px] font-mono py-4">
                  No MCP servers registered.
                </div>
              ) : (
                realMcps.map((mcp) => {
                  const mcpKey = mcp.id || mcp.name;
                  const isSelected = selectedItem === mcpKey;
                  return (
                    <button
                      key={mcpKey}
                      type="button"
                      onClick={() => setSelectedItem(mcpKey)}
                      className={`w-full flex items-center justify-between p-3 rounded-xl border text-left transition-all ${
                        isSelected
                          ? "bg-white/[0.04] border-[#FF5800]/50 shadow-[0_4px_12px_rgba(255,88,0,0.05)] text-white"
                          : "bg-transparent border-white/5 text-white/60 hover:bg-white/[0.02]"
                      }`}
                    >
                      <div className="flex flex-col min-w-0">
                        <span className="font-mono font-bold text-xs uppercase truncate">
                          {mcp.name}
                        </span>
                        <span className="text-[8px] font-mono text-white/30 truncate mt-0.5">
                          {mcp.slug}
                        </span>
                      </div>
                      <span
                        className={`text-[9px] px-1.5 py-0.5 rounded border font-mono ${
                          mcp.status === "live"
                            ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                            : "bg-amber-500/10 text-amber-400 border-amber-500/20"
                        }`}
                      >
                        {mcp.status || "running"}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
            <button
              type="button"
              onClick={() => setSelectedItem("create-mcp")}
              className={`w-full py-2 border border-dashed rounded-xl text-center text-xs transition-all ${
                selectedItem === "create-mcp"
                  ? "border-[#FF5800] text-[#FF5800] bg-[#FF5800]/5"
                  : "border-white/10 text-white/50 hover:text-white bg-white/[0.01] hover:border-[#FF5800]/40"
              }`}
            >
              + Register Custom MCP
            </button>
          </div>

          {/* Right Panel */}
          <div className="flex-1 flex flex-col min-w-0">
            {selectedItem === "create-mcp" ? (
              <div className="flex-1 flex flex-col min-h-0">
                <div className="border-b border-white/10 pb-4 mb-4">
                  <h2 className="text-lg font-bold text-zinc-100 uppercase font-mono">
                    Register Custom MCP Server
                  </h2>
                  <p className="text-[11px] text-white/40 mt-1">
                    Connect an external Model Context Protocol server endpoint
                    to Eliza.
                  </p>
                </div>

                <div className="flex-1 overflow-y-auto pr-2 flex flex-col gap-4 text-xs">
                  {mcpErrorMsg && (
                    <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 font-mono text-[10px]">
                      {mcpErrorMsg}
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1">
                      <label className="font-mono text-[9px] text-white/40 uppercase font-bold">
                        Server Name
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. Weather Service"
                        value={mcpFormName}
                        onChange={(e) => {
                          setMcpFormName(e.target.value);
                          setMcpFormSlug(
                            e.target.value
                              .toLowerCase()
                              .replace(/[^a-z0-9]+/g, "-")
                              .replace(/(^-|-$)/g, ""),
                          );
                        }}
                        className="bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white outline-none focus:border-[#FF5800]/50"
                      />
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="font-mono text-[9px] text-white/40 uppercase font-bold">
                        Server Slug (lowercase, hyphenated)
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. weather-service"
                        value={mcpFormSlug}
                        onChange={(e) => setMcpFormSlug(e.target.value)}
                        className="bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white outline-none focus:border-[#FF5800]/50 font-mono"
                      />
                    </div>
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="font-mono text-[9px] text-white/40 uppercase font-bold">
                      Description
                    </label>
                    <textarea
                      placeholder="Explain what tools and capabilities this MCP server exposes..."
                      value={mcpFormDesc}
                      onChange={(e) => setMcpFormDesc(e.target.value)}
                      rows={3}
                      className="bg-black/40 border border-white/10 rounded-lg p-3 text-white outline-none focus:border-[#FF5800]/50 resize-none"
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="font-mono text-[9px] text-white/40 uppercase font-bold">
                      External Endpoint URL (SSE endpoint)
                    </label>
                    <input
                      type="url"
                      placeholder="https://mcp.mydomain.com/sse"
                      value={mcpFormExternalEndpoint}
                      onChange={(e) =>
                        setMcpFormExternalEndpoint(e.target.value)
                      }
                      className="bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white outline-none focus:border-[#FF5800]/50 font-mono"
                    />
                  </div>

                  <button
                    type="button"
                    disabled={isCreatingMcp}
                    onClick={async () => {
                      if (
                        !mcpFormName ||
                        !mcpFormSlug ||
                        !mcpFormDesc ||
                        !mcpFormExternalEndpoint
                      ) {
                        setMcpErrorMsg("All fields are required.");
                        return;
                      }
                      try {
                        setIsCreatingMcp(true);
                        setMcpErrorMsg("");
                        const res = await api<{ mcp?: McpRecord }>(
                          "/api/v1/mcps",
                          {
                            method: "POST",
                            json: {
                              name: mcpFormName,
                              slug: mcpFormSlug,
                              description: mcpFormDesc,
                              endpointType: "external",
                              externalEndpoint: mcpFormExternalEndpoint,
                            },
                          },
                        );
                        if (res?.mcp) {
                          setMcpFormName("");
                          setMcpFormSlug("");
                          setMcpFormDesc("");
                          setMcpFormExternalEndpoint("");
                          await fetchRealMcps();
                          setSelectedItem(res.mcp.id || res.mcp.name);
                        }
                      } catch (e) {
                        setMcpErrorMsg(
                          e instanceof Error
                            ? e.message
                            : "Failed to register MCP server.",
                        );
                      } finally {
                        setIsCreatingMcp(false);
                      }
                    }}
                    className="w-full mt-2 py-2.5 bg-[#FF5800] disabled:bg-[#FF5800]/50 text-black font-bold rounded-lg hover:bg-[#ff7426] transition-all disabled:cursor-not-allowed cursor-pointer"
                  >
                    {isCreatingMcp
                      ? "Registering Server..."
                      : "Register MCP Server"}
                  </button>
                </div>
              </div>
            ) : (
              (() => {
                const currentMcp = realMcps.find(
                  (m) => (m.id || m.name) === selectedItem,
                );
                if (!currentMcp) {
                  return (
                    <div className="text-white/40 text-center py-20 font-mono text-xs">
                      Select an MCP server from the sidebar or register a new
                      one.
                    </div>
                  );
                }
                return (
                  <div className="flex-1 flex flex-col min-h-0">
                    <div className="flex justify-between items-center border-b border-white/10 pb-4 mb-4">
                      <div>
                        <h2 className="text-lg font-bold text-zinc-100 uppercase font-mono">
                          {currentMcp.name}
                        </h2>
                        <span className="text-[10px] text-white/40 font-mono block mt-0.5">
                          Slug: {currentMcp.slug} | Type:{" "}
                          {currentMcp.endpointType || "External"}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={async () => {
                          if (
                            confirm(
                              "Are you sure you want to delete this MCP server?",
                            )
                          ) {
                            try {
                              await api(
                                `/api/v1/mcps/${currentMcp.id || currentMcp.slug}`,
                                {
                                  method: "DELETE",
                                },
                              );
                              setSelectedItem(null);
                              await fetchRealMcps();
                            } catch (e) {
                              alert(
                                e instanceof Error
                                  ? e.message
                                  : "Failed to delete MCP server.",
                              );
                            }
                          }
                        }}
                        className="px-3 py-1 bg-rose-500/10 border border-rose-500/20 hover:bg-rose-500/20 text-rose-400 text-xs font-bold rounded-lg transition-all cursor-pointer"
                      >
                        Delete Server
                      </button>
                    </div>

                    <div className="flex-1 overflow-y-auto flex flex-col gap-4 text-xs">
                      <div className="flex flex-col gap-1">
                        <span className="font-mono text-[9px] text-white/40 uppercase font-bold">
                          Description
                        </span>
                        <p className="text-white/70 bg-white/[0.01] border border-white/5 p-3 rounded-lg leading-relaxed">
                          {currentMcp.description || "No description provided."}
                        </p>
                      </div>

                      {currentMcp.externalEndpoint && (
                        <div className="flex flex-col gap-1">
                          <span className="font-mono text-[9px] text-white/40 uppercase font-bold">
                            Endpoint URL (SSE)
                          </span>
                          <input
                            type="text"
                            readOnly
                            value={currentMcp.externalEndpoint}
                            className="bg-black/40 border border-white/5 rounded-lg px-3 py-2 text-white/60 font-mono outline-none select-all"
                          />
                        </div>
                      )}

                      <div className="bg-white/[0.01] border border-white/[0.04] rounded-xl p-4 flex flex-col gap-2 mt-2">
                        <span className="text-[10px] font-bold font-mono tracking-widest text-white/30 uppercase">
                          Exposed Capabilities
                        </span>
                        <div className="flex justify-between items-center py-1.5 border-b border-white/5">
                          <span className="text-white/60">Tools</span>
                          <span className="font-semibold text-white/90">
                            {Array.isArray(currentMcp.tools)
                              ? currentMcp.tools.length
                              : 0}{" "}
                            registered
                          </span>
                        </div>
                        <div className="flex justify-between items-center py-1.5 border-b border-white/5">
                          <span className="text-white/60">Pricing Mode</span>
                          <span className="font-semibold text-emerald-400 capitalize">
                            {currentMcp.pricingType || "free"}
                          </span>
                        </div>
                        <div className="flex justify-between items-center py-1.5">
                          <span className="text-white/60">Status</span>
                          <span className="font-semibold text-zinc-300 capitalize">
                            {currentMcp.status}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()
            )}
          </div>
        </div>
      );
    }

    case "containers": {
      const activeContainer =
        containers.find((c) => c.id === selectedItem) || containers[0];
      return (
        <div className="w-full h-full flex gap-6 text-left select-text p-2 animate-fade-up">
          {/* Sidebar */}
          <div className="w-64 shrink-0 flex flex-col gap-2 border-r border-white/10 pr-6">
            <span className="text-[10px] font-bold font-mono tracking-widest text-white/30 uppercase">
              Container Pool
            </span>
            <div className="flex flex-col gap-1.5 overflow-y-auto flex-1">
              {containers.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    setSelectedItem(c.id);
                    setActiveTab("overview");
                  }}
                  className={`w-full flex items-center justify-between p-3 rounded-xl border text-left transition-all ${
                    (selectedItem || containers[0]?.id) === c.id
                      ? "bg-white/[0.04] border-[#FF5800]/50 shadow-[0_4px_12px_rgba(255,88,0,0.05)] text-white"
                      : "bg-transparent border-white/5 text-white/60 hover:bg-white/[0.02]"
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        c.status === "running" || c.status === "active"
                          ? "bg-emerald-400 animate-pulse shadow-[0_0_6px_#34d399]"
                          : "bg-zinc-500"
                      }`}
                    />
                    <span className="font-semibold text-xs truncate">
                      {c.name}
                    </span>
                  </div>
                  <span className="text-[9px] font-mono text-white/30 uppercase truncate max-w-[80px]">
                    {c.image?.split("/").pop()}
                  </span>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setActiveTab("deploy")}
              className="w-full py-2 border border-dashed border-white/10 hover:border-[#FF5800]/40 rounded-xl text-center text-xs text-white/50 hover:text-white bg-white/[0.01] transition-all"
            >
              + Deploy Container
            </button>
          </div>

          {/* Main Content */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="flex justify-between items-start border-b border-white/10 pb-4 mb-4">
              <div>
                <h2 className="text-xl font-bold text-zinc-100 flex items-center gap-3">
                  {activeContainer
                    ? activeContainer.name
                    : "No Container Selected"}
                  {activeContainer && (
                    <span
                      className={`px-2 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider ${
                        activeContainer.status === "running" ||
                        activeContainer.status === "active"
                          ? "bg-emerald-400/10 text-emerald-400 border border-emerald-400/20"
                          : "bg-zinc-500/10 text-zinc-400 border border-zinc-500/20"
                      }`}
                    >
                      {activeContainer.status}
                    </span>
                  )}
                </h2>
                {activeContainer && (
                  <p className="text-xs text-white/30 font-mono mt-1">
                    Image: {activeContainer.image}
                  </p>
                )}
              </div>
              {activeContainer && (
                <button
                  type="button"
                  onClick={async () => {
                    await api(`/api/v1/containers/${activeContainer.id}`, {
                      method: "DELETE",
                    });
                    fetchContainersData();
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold border border-rose-500/30 text-rose-400 hover:bg-rose-500/25 transition-colors"
                >
                  Tear Down
                </button>
              )}
            </div>

            <div className="flex gap-1.5 border-b border-white/5 pb-2 mb-4 text-xs font-mono">
              {["overview", "logs", "deploy"].map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={`tab-btn px-3 py-1 rounded transition-colors uppercase tracking-wider text-[10px] ${
                    activeTab === tab
                      ? "bg-white/10 text-white font-semibold"
                      : "text-white/40 hover:text-white/70 hover:bg-white/5"
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              {activeTab === "overview" && activeContainer && (
                <div className="grid grid-cols-2 gap-4 text-xs">
                  <div className="bg-white/[0.02] border border-white/[0.04] rounded-xl p-4 flex flex-col gap-2">
                    <span className="text-[10px] font-bold font-mono tracking-widest text-white/30 uppercase">
                      Resource Metrics
                    </span>
                    <div className="flex justify-between items-center py-1 border-b border-white/5">
                      <span className="text-white/60">Memory Usage</span>
                      <span className="font-semibold text-white/90">
                        256MB / 512MB
                      </span>
                    </div>
                    <div className="flex justify-between items-center py-1 border-b border-white/5">
                      <span className="text-white/60">CPU Alloc</span>
                      <span className="font-semibold text-white/90">
                        0.5 vCPU
                      </span>
                    </div>
                    <div className="flex justify-between items-center py-1">
                      <span className="text-white/60">Daily Cost</span>
                      <span className="font-semibold text-emerald-400">
                        $0.18
                      </span>
                    </div>
                  </div>

                  <div className="bg-white/[0.02] border border-white/[0.04] rounded-xl p-4 flex flex-col gap-2">
                    <span className="text-[10px] font-bold font-mono tracking-widest text-white/30 uppercase">
                      Quota Limit
                    </span>
                    <div className="flex justify-between items-center py-1 border-b border-white/5">
                      <span className="text-white/60">Pool Capacity</span>
                      <span className="font-semibold text-white/90">
                        {quota.used} / {quota.limit} Used
                      </span>
                    </div>
                    <div className="flex justify-between items-center py-1">
                      <span className="text-white/60">Credit Runway</span>
                      <span className="font-semibold text-amber-400">
                        {quota.creditRunway
                          ? `~${Math.floor(quota.creditRunway)} Days`
                          : "Unlimited"}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === "logs" && activeContainer && (
                <div className="w-full h-48 bg-black/60 border border-white/10 rounded-xl p-3 font-mono text-[10px] text-zinc-400 overflow-y-auto flex flex-col gap-1 select-text scrollbar-thin">
                  <p>
                    <span className="text-sky-400">[2026-06-08 00:10:02]</span>{" "}
                    Loading container environment...
                  </p>
                  <p>
                    <span className="text-emerald-400">
                      [2026-06-08 00:10:03]
                    </span>{" "}
                    Server listening on port 8080
                  </p>
                  <p>
                    <span className="text-violet-400">
                      [2026-06-08 00:10:05]
                    </span>{" "}
                    Connecting to broker at 10.0.0.4
                  </p>
                  <p>
                    <span className="text-emerald-400">
                      [2026-06-08 00:10:06]
                    </span>{" "}
                    Handshake accepted. Container running.
                  </p>
                </div>
              )}

              {activeTab === "deploy" && (
                <div className="flex flex-col gap-3 max-w-lg text-xs">
                  <div className="flex flex-col gap-1.5">
                    <label className="font-mono text-[9px] text-white/40 uppercase font-bold">
                      Container Name
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. eliza-agent-service"
                      value={newContainerName}
                      onChange={(e) => setNewContainerName(e.target.value)}
                      className="bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-white outline-none focus:border-[#FF5800]/50"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="font-mono text-[9px] text-white/40 uppercase font-bold">
                      Docker Image URI
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. ghcr.io/elizaos/my-agent:latest"
                      value={newImage}
                      onChange={(e) => setNewImage(e.target.value)}
                      className="bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-white outline-none focus:border-[#FF5800]/50"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!newImage.trim()) return;
                      await api("/api/v1/containers", {
                        method: "POST",
                        json: {
                          name: newContainerName || "my-container",
                          image: newImage,
                        },
                      });
                      setNewImage("");
                      setNewContainerName("");
                      fetchContainersData();
                      setActiveTab("overview");
                    }}
                    className="w-full mt-2 py-2 bg-[#FF5800] text-black font-bold rounded-lg hover:bg-[#ff7426] transition-all"
                  >
                    Launch Container
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }

    case "domains": {
      return (
        <div className="w-full h-full flex gap-6 text-left select-text p-2 animate-fade-up">
          {/* Left Panel - Add Domain */}
          <div className="w-72 shrink-0 flex flex-col gap-4 border-r border-white/10 pr-6">
            <span className="text-[10px] font-bold font-mono tracking-widest text-white/30 uppercase">
              Add Custom Domain
            </span>
            <div className="flex flex-col gap-3 text-xs">
              <div className="flex flex-col gap-1.5">
                <label className="font-mono text-[9px] text-white/40 uppercase font-bold">
                  Domain Name
                </label>
                <input
                  type="text"
                  placeholder="e.g. myagent.com"
                  value={newDomainName}
                  onChange={(e) => setNewDomainName(e.target.value)}
                  className="bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-white outline-none focus:border-[#FF5800]/50"
                />
              </div>

              {domainStatusMsg && (
                <p className="text-[10px] text-amber-400 font-mono">
                  {domainStatusMsg}
                </p>
              )}

              <button
                type="button"
                onClick={async () => {
                  if (!newDomainName.trim()) return;
                  setDomainStatusMsg("Registering...");
                  try {
                    await api("/api/v1/domains", {
                      method: "POST",
                      json: { domain: newDomainName },
                    });
                    setNewDomainName("");
                    setDomainStatusMsg("Success! DNS verification required.");
                    fetchDomainsData();
                  } catch (err) {
                    setDomainStatusMsg(
                      err instanceof Error
                        ? err.message
                        : "Failed to register domain",
                    );
                  }
                }}
                className="w-full py-2 bg-[#FF5800] text-black font-bold text-xs rounded-xl hover:bg-[#ff7426] transition-all"
              >
                Register Custom Domain
              </button>
            </div>
          </div>

          {/* Right Panel - Domain List */}
          <div className="flex-1 flex flex-col min-w-0">
            <span className="text-[10px] font-bold font-mono tracking-widest text-white/30 uppercase mb-3">
              Managed Domains
            </span>
            <div className="flex-1 overflow-y-auto text-xs">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-white/5 text-left text-[10px] font-mono text-white/30 uppercase">
                    <th className="pb-2 font-medium">Domain</th>
                    <th className="pb-2 font-medium">SSL Status</th>
                    <th className="pb-2 font-medium">Verified</th>
                    <th className="pb-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.02] font-mono">
                  {domains.length === 0 ? (
                    <tr>
                      <td
                        colSpan={4}
                        className="py-4 text-center text-white/30"
                      >
                        No custom domains attached yet.
                      </td>
                    </tr>
                  ) : (
                    domains.map((d) => (
                      <tr key={d.id} className="hover:bg-white/[0.01]">
                        <td className="py-2.5 font-bold text-white/80">
                          {d.domain}
                        </td>
                        <td className="py-2.5 text-white/40">
                          {d.sslStatus || "active"}
                        </td>
                        <td className="py-2.5">
                          <span
                            className={`text-[9px] px-1.5 py-0.5 rounded border uppercase font-bold ${
                              d.verified
                                ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                                : "bg-amber-500/10 border-amber-500/20 text-amber-400"
                            }`}
                          >
                            {d.verified ? "verified" : "pending"}
                          </span>
                        </td>
                        <td className="py-2.5 text-right flex gap-2 justify-end">
                          {!d.verified && (
                            <button
                              type="button"
                              onClick={async () => {
                                const appId = d.appId || "default";
                                setDomainStatusMsg(`Verifying ${d.domain}...`);
                                try {
                                  await api(
                                    `/api/v1/apps/${appId}/domains/verify`,
                                    {
                                      method: "POST",
                                      json: {
                                        domain: d.domain,
                                      },
                                    },
                                  );
                                  alert("Domain verified successfully!");
                                  fetchDomainsData();
                                } catch {
                                  alert(
                                    "DNS verification check failed. Ensure TXT record is set.",
                                  );
                                }
                              }}
                              className="px-2 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded hover:bg-amber-500/20 text-amber-400"
                            >
                              Check DNS
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={async () => {
                              const appId = d.appId || "default";
                              await api(`/api/v1/apps/${appId}/domains`, {
                                method: "DELETE",
                                json: { domain: d.domain },
                              });
                              fetchDomainsData();
                            }}
                            className="px-2 py-0.5 bg-rose-500/10 border border-rose-500/20 rounded hover:bg-rose-500/20 text-rose-400"
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>

              {/* Detailed DNS records info if any domain is selected */}
              {domains.length > 0 && (
                <div className="mt-6 bg-white/[0.01] border border-white/[0.04] p-4 rounded-xl">
                  <h4 className="font-semibold text-white/90 text-sm mb-2">
                    External Domains DNS Configuration
                  </h4>
                  <p className="text-white/40 text-[11px] leading-relaxed mb-3">
                    For domains registered externally, configure the following
                    DNS records at your registrar:
                  </p>
                  <div className="flex flex-col gap-2 font-mono text-[10px]">
                    <div className="flex justify-between items-center bg-black/40 p-2.5 rounded border border-white/5">
                      <div>
                        <span className="text-white/30 uppercase mr-2">
                          Type
                        </span>
                        <span className="text-white">TXT</span>
                      </div>
                      <div>
                        <span className="text-white/30 uppercase mr-2">
                          Name
                        </span>
                        <span className="text-white">@</span>
                      </div>
                      <div>
                        <span className="text-white/30 uppercase mr-2">
                          Value
                        </span>
                        <span className="text-sky-400">
                          eliza-verification-code=4b2c12a7
                        </span>
                      </div>
                    </div>
                    <div className="flex justify-between items-center bg-black/40 p-2.5 rounded border border-white/5">
                      <div>
                        <span className="text-white/30 uppercase mr-2">
                          Type
                        </span>
                        <span className="text-white">CNAME</span>
                      </div>
                      <div>
                        <span className="text-white/30 uppercase mr-2">
                          Name
                        </span>
                        <span className="text-white">www</span>
                      </div>
                      <div>
                        <span className="text-sky-400">
                          cname.elizacloud.ai
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }

    case "remote":
    case "remotePairing": {
      return (
        <div className="w-full h-full flex gap-6 text-left select-text p-2 animate-fade-up">
          {/* Left Panel - Pairing */}
          <div className="w-72 shrink-0 flex flex-col gap-4 border-r border-white/10 pr-6">
            <span className="text-[10px] font-bold font-mono tracking-widest text-white/30 uppercase">
              Pair Device Link
            </span>
            <div className="bg-white/[0.01] border border-white/[0.04] rounded-xl p-4 flex flex-col items-center gap-3">
              <span className="text-[10px] font-bold font-mono text-white/40 uppercase">
                Pairing Authorization
              </span>

              {pairingCode ? (
                <div className="flex flex-col items-center gap-2">
                  <div className="text-2xl font-bold font-mono text-[#FF5800] bg-black/50 border border-white/10 px-4 py-2 rounded-xl tracking-widest">
                    {pairingCode}
                  </div>
                  <p className="text-[9px] text-center text-white/30">
                    Expiry: {pairingExpiry || "5 minutes"} | Status:{" "}
                    {pairingStatus}
                  </p>
                </div>
              ) : (
                <div className="w-32 h-32 bg-white rounded-lg p-2 flex items-center justify-center relative shadow-inner">
                  {/* Simulate QR Code */}
                  <svg
                    width="100"
                    height="100"
                    viewBox="0 0 100 100"
                    className="text-black"
                    role="img"
                    aria-label="QR code"
                  >
                    <title>QR code</title>
                    <rect width="25" height="25" fill="currentColor" />
                    <rect x="75" width="25" height="25" fill="currentColor" />
                    <rect y="75" width="25" height="25" fill="currentColor" />
                    <rect
                      x="35"
                      y="35"
                      width="30"
                      height="30"
                      fill="currentColor"
                    />
                    <rect
                      x="10"
                      y="45"
                      width="10"
                      height="15"
                      fill="currentColor"
                    />
                    <rect
                      x="80"
                      y="40"
                      width="10"
                      height="25"
                      fill="currentColor"
                    />
                  </svg>
                </div>
              )}

              <button
                type="button"
                onClick={handleGeneratePairingCode}
                className="w-full py-2 bg-[#FF5800] text-black font-bold text-xs rounded-xl hover:bg-[#ff7426] transition-all"
              >
                Generate Pairing Code
              </button>
            </div>

            {/* Sync status */}
            <div className="flex flex-col gap-2 text-xs">
              <span className="text-[9px] font-bold font-mono text-white/30 uppercase">
                ElectricSQL Database Sync
              </span>
              <div className="flex justify-between items-center bg-white/[0.01] border border-white/[0.04] p-3 rounded-xl">
                <div>
                  <p className="font-semibold text-white">
                    State: {syncStatus}
                  </p>
                  <p className="text-[9px] text-white/40 mt-0.5">
                    Local ↔ Cloud replica sync active
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSyncStatus("syncing...");
                    setTimeout(() => setSyncStatus("synced"), 1000);
                  }}
                  className="p-1.5 rounded bg-white/5 border border-white/10 hover:bg-white/10"
                >
                  <RefreshCw className="h-3.5 w-3.5 text-white/60" />
                </button>
              </div>
            </div>
          </div>

          {/* Right Panel - Active Sessions */}
          <div className="flex-1 flex flex-col min-w-0">
            <span className="text-[10px] font-bold font-mono tracking-widest text-white/30 uppercase mb-3">
              Active Control Sessions
            </span>
            <div className="flex-1 overflow-y-auto text-xs">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-white/5 text-left text-[10px] font-mono text-white/30 uppercase">
                    <th className="pb-2 font-medium">Session ID</th>
                    <th className="pb-2 font-medium">Device Info</th>
                    <th className="pb-2 font-medium">Status</th>
                    <th className="pb-2 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.02] font-mono">
                  {remoteSessions.length === 0 ? (
                    <tr>
                      <td
                        colSpan={4}
                        className="py-4 text-center text-white/30"
                      >
                        No active remote sessions connected.
                      </td>
                    </tr>
                  ) : (
                    remoteSessions.map((s) => (
                      <tr key={s.id} className="hover:bg-white/[0.01]">
                        <td className="py-2.5 font-bold text-white/80">
                          {s.id.slice(0, 8)}...
                        </td>
                        <td className="py-2.5 text-white/60">
                          {s.deviceInfo || "Mobile Client"}
                        </td>
                        <td className="py-2.5 text-emerald-400 font-bold uppercase text-[9px]">
                          {s.status}
                        </td>
                        <td className="py-2.5 text-right">
                          <button
                            type="button"
                            onClick={async () => {
                              await api(`/api/v1/remote/sessions/${s.id}`, {
                                method: "DELETE",
                              });
                              fetchRemoteData();
                            }}
                            className="px-2 py-0.5 bg-rose-500/10 border border-rose-500/20 rounded hover:bg-rose-500/20 text-rose-400"
                          >
                            Disconnect
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      );
    }

    case "earnings": {
      return (
        <div className="w-full h-full overflow-y-auto p-2 bg-black/40 backdrop-blur-md rounded-xl border border-white/10">
          <Suspense fallback={<DnaLoader />}>
            <EarningsPage />
          </Suspense>
        </div>
      );
    }

    case "affiliates": {
      return (
        <div className="w-full h-full overflow-y-auto p-2 bg-black/40 backdrop-blur-md rounded-xl border border-white/10">
          <Suspense fallback={<DnaLoader />}>
            <AffiliatesPage />
          </Suspense>
        </div>
      );
    }

    case "documents": {
      return (
        <div className="w-full h-full overflow-y-auto p-2 bg-black/40 backdrop-blur-md rounded-xl border border-white/10">
          <Suspense fallback={<DnaLoader />}>
            <DocumentsPage />
          </Suspense>
        </div>
      );
    }

    case "settings": {
      return (
        <div className="w-full h-full overflow-y-auto p-2 bg-black/40 backdrop-blur-md rounded-xl border border-white/10">
          <Suspense fallback={<DnaLoader />}>
            <SettingsPage />
          </Suspense>
        </div>
      );
    }

    case "api-explorer": {
      return (
        <div className="w-full h-full overflow-y-auto p-2 bg-black/40 backdrop-blur-md rounded-xl border border-white/10">
          <Suspense fallback={<DnaLoader />}>
            <ApiExplorerPage />
          </Suspense>
        </div>
      );
    }

    case "admin": {
      return (
        <div className="w-full h-full overflow-y-auto p-2 bg-black/40 backdrop-blur-md rounded-xl border border-white/10">
          <Suspense fallback={<DnaLoader />}>
            <AdminPage />
          </Suspense>
        </div>
      );
    }

    case "profile": {
      return (
        <div className="w-full h-full overflow-y-auto p-2 bg-black/40 backdrop-blur-md rounded-xl border border-white/10 animate-fade-up">
          <Suspense fallback={<DnaLoader />}>
            <AccountPage />
          </Suspense>
        </div>
      );
    }

    case "apps": {
      return (
        <div className="w-full h-full overflow-y-auto p-2 bg-black/40 backdrop-blur-md rounded-xl border border-white/10 animate-fade-up">
          <Suspense fallback={<DnaLoader />}>
            <AppsPage />
          </Suspense>
        </div>
      );
    }

    default:
      return null;
  }
}

// ── Artifact Window Component (The Floating Node Card) ──
interface ArtifactWindowProps {
  tabId: string;
  node: WorkspaceNode;
  onClose: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
  handleAction: (action: string, params?: Record<string, unknown>) => void;
  onReload: () => void;
  onHeaderMouseDown: (e: React.MouseEvent) => void;
  onResizeMouseDown: (e: React.MouseEvent) => void;
  agentsQuery: AgentsQuery;
  apiKeysQuery: ApiKeysQuery;
  creditBalance: number | null | undefined;
  genuiActionHandler?: ElizaGenUiActionHandler;
  runPrompt: (promptText: string) => void;
}

function ArtifactWindow({
  tabId,
  node,
  onClose,
  onMinimize,
  onMaximize,
  handleAction,
  onHeaderMouseDown,
  onResizeMouseDown,
  agentsQuery,
  apiKeysQuery,
  creditBalance,
  genuiActionHandler,
  runPrompt,
}: ArtifactWindowProps) {
  const Icon = getViewIcon(node.type);
  const [copied, setCopied] = useState(false);
  const [liked, setLiked] = useState<boolean | null>(null);

  useEffect(() => {
    const isPremiumType = [
      "agents",
      "billing",
      "apikeys",
      "analytics",
      "security",
      "connectors",
      "mcps",
      "containers",
      "domains",
      "remote",
      "remotePairing",
      "health",
      "profile",
      "apps",
      "earnings",
      "affiliates",
      "documents",
      "settings",
      "api-explorer",
      "admin",
    ].includes(node.type);
    if (!node.spec && !node.genuiSpec && !isPremiumType) {
      const type = node.type;
      const promptText = type === "custom" ? "regenerate view" : `show ${type}`;
      processUserMessage(promptText, [])
        .then((r) => {
          if (r.spec) {
            useCanvasStore.getState().updateNodeSpec(node.id, r.spec);
          }
        })
        .catch((err) => {
          console.error("Failed to load spec for node:", node.id, err);
        });
    }
  }, [node.id, node.spec, node.genuiSpec, node.type]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const specData = node.spec || node.genuiSpec;
    if (specData) {
      navigator.clipboard.writeText(JSON.stringify(specData, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const _handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    const specData = node.spec || node.genuiSpec;
    if (specData) {
      const blob = new Blob([JSON.stringify(specData, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${node.name}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  return (
    <div
      style={
        node.isMaximized
          ? {
              position: "absolute",
              left: "16px",
              top: "16px",
              right: "16px",
              bottom: "16px",
            }
          : {
              position: "absolute",
              left: `${node.x}px`,
              top: `${node.y}px`,
              width: `${node.width}px`,
              height: node.isMinimized ? "32px" : `${node.height}px`,
            }
      }
      className={`flex flex-col rounded-2xl overflow-hidden shadow-2xl transition-all duration-300 pointer-events-auto group/card ${
        node.type === "chat-response"
          ? "bg-white/[0.02] border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.2)] backdrop-blur-md"
          : "glass-card"
      } ${node.isMaximized ? "border-[#FF5800]/50 shadow-[#FF5800]/5" : ""}`}
    >
      {/* Header Bar - Handles Dragging */}
      <div
        onMouseDown={node.isMaximized ? undefined : onHeaderMouseDown}
        className={`flex h-8 shrink-0 items-center justify-between px-3 select-none ${
          node.type === "chat-response"
            ? "bg-transparent border-b border-white/[0.03]"
            : "glass-header"
        } ${
          node.isMaximized
            ? "cursor-default"
            : "cursor-grab active:cursor-grabbing"
        }`}
      >
        {/* Left Side: macOS traffic lights */}
        <div
          className="flex items-center gap-1.5 shrink-0 group/traffic-lights"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* Close (Red) */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            title="Close"
            className="w-3 h-3 rounded-full traffic-light-btn bg-[#ff5f56]/80 hover:bg-[#ff5f56] border border-white/5 transition-all duration-150 relative flex items-center justify-center group/btn"
          >
            <span className="opacity-0 group-hover/btn:opacity-100 text-[8px] text-[#4c0002] font-bold select-none absolute">
              ×
            </span>
          </button>

          {/* Minimize (Yellow) */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onMinimize();
            }}
            title="Minimize"
            className="w-3 h-3 rounded-full traffic-light-btn bg-[#ffbd2e]/80 hover:bg-[#ffbd2e] border border-white/5 transition-all duration-150 relative flex items-center justify-center group/btn"
          >
            <span className="opacity-0 group-hover/btn:opacity-100 text-[6px] text-[#5c3e00] font-bold select-none absolute font-mono -top-[1px]">
              -
            </span>
          </button>

          {/* Maximize (Green) */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onMaximize();
            }}
            title="Maximize"
            className="w-3 h-3 rounded-full traffic-light-btn bg-[#27c93f]/80 hover:bg-[#27c93f] border border-white/5 transition-all duration-150 relative flex items-center justify-center group/btn"
          >
            <span className="opacity-0 group-hover/btn:opacity-100 text-[5px] text-[#003300] font-bold select-none absolute">
              ⤢
            </span>
          </button>
        </div>

        {/* Center/Left: Icon & Title & Status dot */}
        <div className="flex-1 flex items-center gap-2 px-3 text-[11px] font-mono tracking-wider text-white/60 min-w-0">
          <Icon className="h-3.5 w-3.5 text-[#FF5800] shrink-0" />
          <span className="truncate font-semibold text-zinc-300 drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]">
            {formatNodeTitle(node.name)}
          </span>
          <div
            className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399] animate-pulse shrink-0"
            title="System Status: Connected"
          />
        </div>
      </div>

      {/* Content Area & Floating Actions (Visible only if not minimized) */}
      {!node.isMinimized && (
        <>
          {/* Content Area */}
          <div
            className={`flex-1 overflow-y-auto relative min-h-0 glass-content ${
              node.isMaximized
                ? "p-6 flex flex-col items-stretch justify-start"
                : "pt-4 px-4 pb-6 flex flex-col justify-center items-center"
            }`}
          >
            {node.type === "chat-response" ? (
              (() => {
                const text = node.content || "ok lets chat about this";
                const len = text.length;
                let fontSizeClass = "text-sm";
                let leadingClass = "leading-relaxed";

                if (len < 50) {
                  fontSizeClass =
                    "text-xl font-light tracking-tight text-white/95";
                  leadingClass = "leading-normal";
                } else if (len < 150) {
                  fontSizeClass = "text-base font-light text-white/90";
                  leadingClass = "leading-relaxed";
                } else if (len < 300) {
                  fontSizeClass = "text-sm font-normal text-white/85";
                  leadingClass = "leading-relaxed";
                } else {
                  fontSizeClass = "text-xs font-normal text-white/80";
                  leadingClass = "leading-normal";
                }

                return (
                  <div
                    className={`text-center font-sans ${fontSizeClass} ${leadingClass} w-full max-w-xl px-6 py-4 bg-transparent border-0 shadow-none backdrop-blur-none`}
                    style={{
                      fontFamily: "'Outfit', 'Inter', sans-serif",
                      animation:
                        "fadeUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards",
                    }}
                  >
                    <StreamingText text={text} />
                  </div>
                );
              })()
            ) : [
                "agents",
                "billing",
                "apikeys",
                "analytics",
                "security",
                "connectors",
                "mcps",
                "containers",
                "domains",
                "remote",
                "remotePairing",
                "health",
                "profile",
                "apps",
                "earnings",
                "affiliates",
                "documents",
                "settings",
                "api-explorer",
                "admin",
              ].includes(node.type) ? (
              <PremiumNodeRenderer
                node={node}
                isMaximized={node.isMaximized || false}
                handleAction={handleAction}
                runPrompt={runPrompt}
                agentsQuery={agentsQuery}
                apiKeysQuery={apiKeysQuery}
                creditBalance={creditBalance}
              />
            ) : (
              <>
                {node.spec && (
                  <UiRenderer spec={node.spec} onAction={handleAction} />
                )}
                {node.genuiSpec && (
                  <ElizaGenUiRenderer
                    spec={node.genuiSpec}
                    context={{
                      nodeId: node.id,
                      data: {
                        isMaximized: node.isMaximized || false,
                      },
                    }}
                    actionHandlers={
                      genuiActionHandler ? [genuiActionHandler] : undefined
                    }
                    className="w-full"
                  />
                )}
                {!node.spec && !node.genuiSpec && <DnaLoader />}
              </>
            )}
          </div>

          {/* Floating Actions Overlay (Hover options, minimal container) */}
          {node.type !== "chat-response" && (
            <div className="absolute bottom-2.5 right-2.5 z-30 flex items-center gap-1.5 pointer-events-none opacity-0 translate-y-1 group-hover/card:opacity-100 group-hover/card:translate-y-0 group-hover/card:pointer-events-auto transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]">
              {/* Copy Spec */}
              <button
                type="button"
                onClick={handleCopy}
                title={copied ? "Copied spec!" : "Copy spec JSON"}
                className={`overlay-action-btn ${copied ? "btn-copy-active" : "btn-copy"}`}
              >
                <Copy className="h-3 w-3" />
                <span>{copied ? "Copied" : "Copy"}</span>
              </button>

              {/* Like */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setLiked(true);
                }}
                title="Intake correct / Good UI"
                className={`overlay-action-btn ${liked === true ? "btn-like-active" : "btn-like"}`}
              >
                <ThumbsUp className="h-3 w-3" />
              </button>

              {/* Dislike */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setLiked(false);
                }}
                title="Intake incorrect / Bad UI"
                className={`overlay-action-btn ${liked === false ? "btn-dislike-active" : "btn-dislike"}`}
              >
                <ThumbsDown className="h-3 w-3" />
              </button>

              {/* Comment */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  useCanvasStore.getState().openChatForNode(tabId, node.id);
                }}
                title="Comment on view"
                className="overlay-action-btn btn-comment"
              >
                <MessageSquare className="h-3 w-3" />
              </button>

              {/* Share */}
              <button
                type="button"
                title="Share workspace component"
                className="overlay-action-btn btn-share"
              >
                <Share2 className="h-3 w-3" />
              </button>
            </div>
          )}
        </>
      )}

      {/* Custom Resize Handle (Visible only if not minimized and not maximized) */}
      {!node.isMinimized && !node.isMaximized && (
        <div
          onMouseDown={onResizeMouseDown}
          className="absolute bottom-0.5 right-0.5 w-3.5 h-3.5 cursor-se-resize flex items-end justify-end p-0.5 group z-10"
          title="Resize window"
        >
          <svg
            width="8"
            height="8"
            viewBox="0 0 8 8"
            className="text-white/20 group-hover:text-[#FF5800] transition-colors"
            role="img"
            aria-label="Close"
          >
            <title>Close</title>
            <line
              x1="6"
              y1="2"
              x2="2"
              y2="6"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <line
              x1="6"
              y1="4"
              x2="4"
              y2="6"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>
        </div>
      )}
    </div>
  );
}

// ── Templates & Community Layout Definitions ──
interface PredefinedTemplate {
  id: string;
  name: string;
  description: string;
  creator?: string;
  views: {
    name: string;
    nodes: {
      id: string;
      name: string;
      type: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }[];
  }[];
}

const WORKSPACE_TEMPLATES: PredefinedTemplate[] = [
  {
    id: "template-dev-suite",
    name: "Developer Suite",
    description:
      "Ideal for configuring agents, plugins, and custom MCP connectors.",
    views: [
      {
        name: "agents",
        nodes: [
          {
            id: "node-1",
            name: "agents",
            type: "agents",
            x: 60,
            y: 40,
            width: 440,
            height: 500,
          },
          {
            id: "node-2",
            name: "connectors",
            type: "connectors",
            x: 540,
            y: 40,
            width: 420,
            height: 480,
          },
        ],
      },
      {
        name: "mcp & credentials",
        nodes: [
          {
            id: "node-3",
            name: "mcp servers",
            type: "mcps",
            x: 60,
            y: 40,
            width: 440,
            height: 500,
          },
          {
            id: "node-4",
            name: "api keys",
            type: "apikeys",
            x: 540,
            y: 40,
            width: 420,
            height: 480,
          },
        ],
      },
    ],
  },
  {
    id: "template-ops-center",
    name: "Operations Console",
    description:
      "Designed for tracking analytics, health, security, and billing.",
    views: [
      {
        name: "monitoring",
        nodes: [
          {
            id: "node-5",
            name: "analytics",
            type: "analytics",
            x: 60,
            y: 40,
            width: 480,
            height: 520,
          },
          {
            id: "node-6",
            name: "security",
            type: "security",
            x: 580,
            y: 40,
            width: 420,
            height: 480,
          },
        ],
      },
      {
        name: "billing",
        nodes: [
          {
            id: "node-7",
            name: "billing",
            type: "billing",
            x: 60,
            y: 40,
            width: 440,
            height: 500,
          },
        ],
      },
    ],
  },
  {
    id: "template-security-audit",
    name: "Security Vault",
    description:
      "Focused on API key administration, secrets management, and access compliance.",
    views: [
      {
        name: "compliance",
        nodes: [
          {
            id: "node-8",
            name: "security",
            type: "security",
            x: 60,
            y: 40,
            width: 440,
            height: 500,
          },
          {
            id: "node-9",
            name: "api keys",
            type: "apikeys",
            x: 540,
            y: 40,
            width: 420,
            height: 480,
          },
        ],
      },
    ],
  },
  {
    id: "template-mcp-gateway",
    name: "MCP Gateway",
    description:
      "Optimize connection routes, manage custom servers, and configure external registries.",
    views: [
      {
        name: "servers",
        nodes: [
          {
            id: "node-10",
            name: "mcp servers",
            type: "mcps",
            x: 60,
            y: 40,
            width: 440,
            height: 500,
          },
          {
            id: "node-11",
            name: "connectors",
            type: "connectors",
            x: 540,
            y: 40,
            width: 420,
            height: 480,
          },
        ],
      },
      {
        name: "auth",
        nodes: [
          {
            id: "node-12",
            name: "api keys",
            type: "apikeys",
            x: 60,
            y: 40,
            width: 440,
            height: 500,
          },
        ],
      },
    ],
  },
  {
    id: "template-financial-monitor",
    name: "Financial Monitor",
    description:
      "Designed for tracking platform expenditures, agent run cost models, and invoices.",
    views: [
      {
        name: "ledger",
        nodes: [
          {
            id: "node-13",
            name: "billing",
            type: "billing",
            x: 60,
            y: 40,
            width: 440,
            height: 500,
          },
          {
            id: "node-14",
            name: "analytics",
            type: "analytics",
            x: 540,
            y: 40,
            width: 480,
            height: 520,
          },
        ],
      },
    ],
  },
];

const COMMUNITY_TEMPLATES: PredefinedTemplate[] = [
  {
    id: "community-trading-bot",
    name: "Trading Terminal",
    creator: "@alpha_quant",
    description:
      "Custom layout built for real-time market event streaming and transaction analytics.",
    views: [
      {
        name: "trading desk",
        nodes: [
          {
            id: "c-node-1",
            name: "agents",
            type: "agents",
            x: 40,
            y: 40,
            width: 440,
            height: 500,
          },
          {
            id: "c-node-2",
            name: "analytics",
            type: "analytics",
            x: 510,
            y: 40,
            width: 480,
            height: 520,
          },
        ],
      },
      {
        name: "gateways",
        nodes: [
          {
            id: "c-node-3",
            name: "mcp servers",
            type: "mcps",
            x: 60,
            y: 40,
            width: 440,
            height: 500,
          },
        ],
      },
    ],
  },
  {
    id: "community-chat-lab",
    name: "Agent Playroom",
    creator: "@meta_builder",
    description:
      "An open, clutter-free environment configured with multiple concurrent chat windows.",
    views: [
      {
        name: "chat lab",
        nodes: [
          {
            id: "c-node-4",
            name: "agent chat",
            type: "agents",
            x: 60,
            y: 40,
            width: 440,
            height: 500,
          },
          {
            id: "c-node-5",
            name: "sandbox view",
            type: "agents",
            x: 540,
            y: 40,
            width: 440,
            height: 500,
          },
        ],
      },
    ],
  },
  {
    id: "community-shop-sync",
    name: "Store Coordinator",
    creator: "@shop_dev",
    description:
      "Tailored for database synchronization and storefront plug-in monitoring.",
    views: [
      {
        name: "store integrations",
        nodes: [
          {
            id: "c-node-6",
            name: "connectors",
            type: "connectors",
            x: 60,
            y: 40,
            width: 440,
            height: 500,
          },
          {
            id: "c-node-7",
            name: "mcp servers",
            type: "mcps",
            x: 540,
            y: 40,
            width: 420,
            height: 480,
          },
        ],
      },
    ],
  },
  {
    id: "community-customer-care",
    name: "Customer Care",
    creator: "@support_guru",
    description:
      "Multi-agent setup with analytics for customer experience desks and ticket resolution flows.",
    views: [
      {
        name: "dashboard",
        nodes: [
          {
            id: "c-node-8",
            name: "agents",
            type: "agents",
            x: 40,
            y: 40,
            width: 440,
            height: 500,
          },
          {
            id: "c-node-9",
            name: "analytics",
            type: "analytics",
            x: 510,
            y: 40,
            width: 480,
            height: 520,
          },
          {
            id: "c-node-10",
            name: "connectors",
            type: "connectors",
            x: 60,
            y: 600,
            width: 440,
            height: 500,
          },
        ],
      },
    ],
  },
  {
    id: "community-security-cop",
    name: "Security Cop",
    creator: "@sec_inspector",
    description:
      "Enterprise monitoring layout for compliance checkpoints, API key rotation, and firewall audits.",
    views: [
      {
        name: "compliance",
        nodes: [
          {
            id: "c-node-11",
            name: "security",
            type: "security",
            x: 40,
            y: 40,
            width: 440,
            height: 500,
          },
          {
            id: "c-node-12",
            name: "api keys",
            type: "apikeys",
            x: 510,
            y: 40,
            width: 420,
            height: 480,
          },
          {
            id: "c-node-13",
            name: "mcp servers",
            type: "mcps",
            x: 60,
            y: 600,
            width: 440,
            height: 500,
          },
        ],
      },
    ],
  },
  {
    id: "community-dev-sandbox",
    name: "Dev Sandbox",
    creator: "@code_pilot",
    description:
      "Minimalist workspace layout for fast prototyping, local MCP testing, and sandbox runs.",
    views: [
      {
        name: "sandbox",
        nodes: [
          {
            id: "c-node-14",
            name: "agents",
            type: "agents",
            x: 60,
            y: 40,
            width: 440,
            height: 500,
          },
          {
            id: "c-node-15",
            name: "mcp servers",
            type: "mcps",
            x: 540,
            y: 40,
            width: 440,
            height: 500,
          },
        ],
      },
    ],
  },
];

// ── Main Cloud Node Canvas Component ──
export function CloudCanvas() {
  const {
    views,
    activeViewId,
    snapshots,
    openView,
    closeView,
    addTab,
    renameTab,
    moveNode,
    closeNode,
    minimizeNode,
    maximizeNode,
    resizeNode,
    setTabPan,
    saveWorkspaceSnapshot,
    loadWorkspaceSnapshot,
    deleteWorkspaceSnapshot,
    addMessage,
    setProcessing,
  } = useCanvasStore();

  const { user, stewardAuthenticated } = useSessionAuth();
  const { signOut: stewardSignOut } = useStewardAuth();
  const navigate = useNavigate();

  const { creditBalance } = useCredits();
  const agentsQuery = useAgents();
  const apiKeysQuery = useApiKeys();

  const agents = agentsQuery.data ?? [];
  const runningCount = useMemo(
    () => agents.filter((a) => a.status === "running").length,
    [agents],
  );
  const isApiOffline = agentsQuery.isError || apiKeysQuery.isError;

  const apiKeys = apiKeysQuery.data ?? [];
  const activeKeysCount = useMemo(
    () => apiKeys.filter((k) => k.is_active).length,
    [apiKeys],
  );

  const balanceStr = useMemo(() => {
    if (creditBalance === null || creditBalance === undefined) return "0.00";
    return Number(creditBalance).toFixed(2);
  }, [creditBalance]);

  // Handle Sign Out from Bottom Panel
  const handleSignOut = useCallback(async () => {
    try {
      // Clear chat data (rooms, entityId, localStorage)
      useChatStore.getState().clearChatData();

      if (stewardAuthenticated) {
        stewardSignOut();
        await fetch(STEWARD_SESSION_ENDPOINT, { method: "DELETE" }).catch(
          () => {},
        );
      }
      await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});

      // Use replace to avoid browser history pollution
      navigate("/", { replace: true });
    } catch (error) {
      console.error("[WorkspaceCanvas] Error during sign out:", error);
      navigate("/", { replace: true });
    }
  }, [stewardAuthenticated, stewardSignOut, navigate]);

  const location = useLocation();

  const handleCloseNodeAndNav = useCallback(
    (tabId: string, nodeId: string) => {
      const node = views
        .find((v) => v.id === tabId)
        ?.nodes?.find((n) => n.id === nodeId);
      closeNode(tabId, nodeId);
      if (node && location.pathname.includes(node.type)) {
        navigate("/dashboard");
      }
    },
    [views, closeNode, navigate, location.pathname],
  );

  const handleMaximizeNodeAndNav = useCallback(
    (tabId: string, nodeId: string, maximize: boolean) => {
      const node = views
        .find((v) => v.id === tabId)
        ?.nodes?.find((n) => n.id === nodeId);
      maximizeNode(tabId, nodeId, maximize);
      if (node) {
        if (maximize) {
          let path = "/dashboard";
          if (node.type === "agents") path = "/dashboard/agents";
          else if (node.type === "apikeys") path = "/dashboard/api-keys";
          else if (node.type === "billing") path = "/dashboard/billing";
          else if (node.type === "mcps") path = "/dashboard/mcps";
          else if (node.type === "security") path = "/dashboard/security";
          else if (node.type === "settings") path = "/dashboard/settings";
          else if (node.type === "containers") path = "/dashboard/apps";
          else if (node.type === "analytics") path = "/dashboard/analytics";
          else if (node.type === "earnings") path = "/dashboard/earnings";
          else if (node.type === "affiliates") path = "/dashboard/affiliates";
          else if (node.type === "documents") path = "/dashboard/documents";
          else if (node.type === "api-explorer")
            path = "/dashboard/api-explorer";
          else if (node.type === "admin") path = "/dashboard/admin";

          if (location.pathname !== path) {
            navigate(path);
          }
        } else {
          if (
            location.pathname !== "/dashboard" &&
            location.pathname !== "/dashboard/my-agents"
          ) {
            navigate("/dashboard");
          }
        }
      }
    },
    [views, maximizeNode, navigate, location.pathname],
  );

  // Local UI states
  const [selectorHovered, setSelectorHovered] = useState(false);
  const [newSnapshotName, setNewSnapshotName] = useState("");
  const [isSavingNewSnapshot, setIsSavingNewSnapshot] = useState(false);
  const [isDraggingSnapshot, setIsDraggingSnapshot] = useState(false);
  const [activeSelectorTab, setActiveSelectorTab] = useState<
    "my" | "templates" | "community"
  >("my");

  const loadTemplate = useCallback((template: PredefinedTemplate) => {
    const migratedViews = template.views.map((v) => ({
      id: crypto.randomUUID(),
      name: v.name,
      nodes: v.nodes.map((n) => ({
        id: crypto.randomUUID(),
        name: n.name,
        type: n.type,
        spec: null,
        genuiSpec: null,
        x: n.x,
        y: n.y,
        width: n.width,
        height: n.height,
        isMinimized: false,
        isMaximized: false,
      })),
      panX: 0,
      panY: 0,
    }));

    useCanvasStore.setState({
      views: migratedViews,
      activeViewId: migratedViews.length > 0 ? migratedViews[0].id : null,
      canvasMode: migratedViews.length > 0 ? "viewing" : "chat",
    });
  }, []);

  // Tab renaming states
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabName, setEditingTabName] = useState("");

  // Derive username
  const username = useMemo(() => {
    if (!user) return "there";
    if (user.email) {
      return (
        user.email.split("@")[0].charAt(0).toUpperCase() +
        user.email.split("@")[0].slice(1)
      );
    }
    return user.id?.slice(0, 8) ?? "there";
  }, [user]);

  // Run Prompt query helper
  const runPrompt = useCallback(
    (promptText: string) => {
      addMessage({ role: "user", content: promptText });
      setProcessing(true);

      import("@/lib/stores/cloud-assistant-agent").then(
        ({ processUserMessage }) => {
          const msgs = useCanvasStore.getState().messages;
          processUserMessage(promptText, msgs)
            .then((r) => {
              const activeStore = useCanvasStore.getState();
              activeStore.addMessage({
                role: "assistant",
                content: r.text,
                spec: r.spec ?? undefined,
              });
              activeStore.handleAssistantResponse(
                r.text,
                r.spec ?? null,
                promptText,
              );
            })
            .catch(() =>
              useCanvasStore.getState().addMessage({
                role: "assistant",
                content: "Something went wrong.",
              }),
            )
            .finally(() => useCanvasStore.getState().setProcessing(false));
        },
      );
    },
    [addMessage, setProcessing],
  );

  // ── Proactive assessment on first canvas mount ──
  const hasAutoAssessed = useRef(false);
  useEffect(() => {
    const store = useCanvasStore.getState();
    // Only auto-assess if user is logged in and canvas has no existing messages
    if (hasAutoAssessed.current || store.messages.length > 0 || !user) return;
    hasAutoAssessed.current = true;

    setProcessing(true);
    assessAndGreet()
      .then((result) => {
        const activeStore = useCanvasStore.getState();
        activeStore.addMessage({
          role: "assistant",
          content: result.text,
          spec: result.spec ?? undefined,
        });
        activeStore.handleAssistantResponse(
          result.text,
          result.spec ?? null,
          "__auto_assessment__",
        );
      })
      .catch(() => {
        // Silently fail — user can still interact manually
      })
      .finally(() => useCanvasStore.getState().setProcessing(false));
  }, [user, setProcessing]);

  // Action dispatcher
  const handleAction = useCallback(
    (action: string, params?: Record<string, unknown>) => {
      if (action === "setState") return;
      const store = useCanvasStore.getState();
      if (action === "cloud.navigate" && params?.to) {
        navigate(params.to as string);
        return;
      }
      if (action === "cloud.openBilling") {
        runPrompt("show billing overview");
        return;
      }
      if (action.startsWith("cloud.")) {
        store.setProcessing(true);
        processAction(action, params).then((result) => {
          if (result) {
            store.addMessage({
              role: "assistant",
              content: result.text,
              spec: result.spec ?? undefined,
            });
            store.handleAssistantResponse(
              result.text,
              result.spec ?? null,
              action,
            );
          }
          store.setProcessing(false);
        });
      }
    },
    [navigate, runPrompt],
  );

  const genuiActionHandler = useMemo(() => {
    const prefixes = [
      "setup.",
      "model.",
      "provider.",
      "connector.",
      "runtime.",
      "capability.",
      "dynamicView.",
      "trace.",
      "voice.",
      "cloud.",
    ];
    return createElizaGenUiPrefixActionHandler(
      prefixes,
      async (action, _ctx) => {
        let actionName = action.event.name;
        const payload = action.event.payload as
          | Record<string, unknown>
          | undefined;

        const nodeId = _ctx.nodeId as string | undefined;
        if (
          actionName === "cloud.profile.maximize" ||
          actionName === "cloud.maximize"
        ) {
          const targetNodeId = nodeId || (payload?.nodeId as string);
          if (targetNodeId && activeViewId) {
            useCanvasStore
              .getState()
              .maximizeNode(activeViewId, targetNodeId, true);
          }
          return { ok: true };
        }

        if (!actionName.startsWith("cloud.")) {
          // Map common actions to prompts or equivalent cloud actions
          if (actionName === "setup.dismiss") {
            runPrompt("keep starter model");
            return { ok: true };
          }
          if (actionName === "setup.step.click" && payload?.step) {
            runPrompt(`setup step: ${payload.step}`);
            return { ok: true };
          }
          if (actionName === "setup.diagnostics.run") {
            runPrompt("rerun diagnostics");
            return { ok: true };
          }
          if (actionName === "model.select") {
            handleAction("cloud.agent.select", payload);
            return { ok: true };
          }
          if (actionName === "model.download.start") {
            handleAction("cloud.agent.provision", payload);
            return { ok: true };
          }
          if (actionName === "model.download.toggle" && payload?.modelId) {
            runPrompt(`toggle download for model ${payload.modelId}`);
            return { ok: true };
          }
          if (actionName === "model.download.cancel" && payload?.modelId) {
            runPrompt(`cancel download for model ${payload.modelId}`);
            return { ok: true };
          }
          if (actionName === "provider.setup.save" && payload?.providerId) {
            runPrompt(`save provider config for ${payload.providerId}`);
            return { ok: true };
          }
          if (actionName === "provider.setup.check" && payload?.providerId) {
            runPrompt(`test provider config for ${payload.providerId}`);
            return { ok: true };
          }
          if (actionName === "connector.setup.save" && payload?.connectorId) {
            runPrompt(
              `save connector config for ${payload.connectorId} enabled: ${payload.enabled}`,
            );
            return { ok: true };
          }
          if (actionName === "permission.approve" && payload?.permissionId) {
            runPrompt(`approve permission ${payload.permissionId}`);
            return { ok: true };
          }
          if (actionName === "permission.deny" && payload?.permissionId) {
            runPrompt(`deny permission ${payload.permissionId}`);
            return { ok: true };
          }
          if (actionName === "trace.refresh") {
            runPrompt("refresh execution trace");
            return { ok: true };
          }
          if (actionName === "voice.reconnect") {
            runPrompt("reconnect audio voice stream");
            return { ok: true };
          }
          if (actionName === "runtime.tool.kill" && payload?.toolId) {
            runPrompt(`kill tool execution ${payload.toolId}`);
            return { ok: true };
          }
          if (actionName === "runtime.terminal.send" && payload?.command) {
            runPrompt(`terminal command ${payload.command}`);
            return { ok: true };
          }
          if (actionName === "capability.file.open" && payload?.path) {
            runPrompt(`open file ${payload.path}`);
            return { ok: true };
          }
          if (actionName === "capability.file.edit" && payload?.path) {
            runPrompt(`edit file ${payload.path}`);
            return { ok: true };
          }
          if (actionName === "capability.git.commit" && payload?.filePath) {
            runPrompt(`commit git changes for ${payload.filePath}`);
            return { ok: true };
          }
          if (actionName === "capability.git.discard" && payload?.filePath) {
            runPrompt(`discard git changes for ${payload.filePath}`);
            return { ok: true };
          }

          // Default fallback: prefix with cloud.
          actionName = `cloud.${actionName}`;
        }

        handleAction(actionName, payload);
        return { ok: true };
      },
    );
  }, [handleAction, runPrompt, activeViewId]);

  // Safely migrate any old views on the fly to support nodes structure
  const safeViews = useMemo(() => {
    return views.map((v) => {
      let migratedNodes = v.nodes || [];
      if (!Array.isArray(v.nodes)) {
        // Convert old structure on-the-fly
        const oldView = v as WorkspaceView & {
          spec?: WorkspaceNode["spec"];
          genuiSpec?: WorkspaceNode["genuiSpec"];
          type?: string;
          isMinimized?: boolean;
          isMaximized?: boolean;
        };
        migratedNodes = [];
        if (oldView.spec || oldView.genuiSpec) {
          migratedNodes.push({
            id: oldView.id,
            name: oldView.name,
            type: oldView.type || "custom",
            spec: oldView.spec || null,
            genuiSpec: oldView.genuiSpec || null,
            x: 100,
            y: 100,
            width: 420,
            height: 480,
            isMinimized: oldView.isMinimized || false,
            isMaximized: oldView.isMaximized || false,
          });
        }
      }

      // Convert any legacy spec nodes to genuiSpec
      const finalNodes = migratedNodes.map((node) => {
        if (node.spec && !node.genuiSpec) {
          try {
            const genuiSpec = officialSpecToEliza(
              node.spec as Parameters<typeof officialSpecToEliza>[0],
            );
            return { ...node, spec: null, genuiSpec };
          } catch {
            return node;
          }
        }
        return node;
      });

      return {
        id: v.id,
        name: v.name,
        nodes: finalNodes,
        panX: v.panX || 0,
        panY: v.panY || 0,
      };
    });
  }, [views]);

  // Find active tab and its components
  const activeTab = useMemo(
    () => safeViews.find((v) => v.id === activeViewId),
    [safeViews, activeViewId],
  );
  const hasTabs = safeViews.length > 0;
  const activeNodes = activeTab?.nodes || [];
  // These node interactions only run when a view is active; fall back to an
  // empty id (a no-op lookup in the store) when none is selected.
  const currentViewId = activeViewId ?? "";

  // Panning coordinates
  const panX = activeTab?.panX ?? 0;
  const panY = activeTab?.panY ?? 0;

  // Render maximized node overlay if one is maximized
  const maximizedNode = useMemo(
    () => activeNodes.find((n) => n.isMaximized),
    [activeNodes],
  );

  // Drag and Drop files/snapshots handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingSnapshot(true);
  };

  const handleDragLeave = () => {
    setIsDraggingSnapshot(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingSnapshot(false);
    const id = e.dataTransfer.getData("text/plain");
    if (id) {
      loadWorkspaceSnapshot(id);
    }
  };

  // Drag to pan background coordinates
  const startPan = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // Left click only
    const target = e.target as HTMLElement;
    // Only drag on canvas viewport background directly
    if (
      !target.classList.contains("canvas-grid-bg") &&
      !target.classList.contains("canvas-viewport")
    )
      return;

    e.preventDefault();
    if (!activeTab) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const initPanX = activeTab.panX;
    const initPanY = activeTab.panY;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      setTabPan(activeTab.id, initPanX + dx, initPanY + dy);
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  // Wheel to pan background coordinates
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!activeTab) return;
      setTabPan(
        activeTab.id,
        activeTab.panX - e.deltaX,
        activeTab.panY - e.deltaY,
      );
    },
    [activeTab, setTabPan],
  );

  // Card header dragging
  const startNodeDrag = (node: WorkspaceNode, e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const initX = node.x;
    const initY = node.y;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!activeViewId) return;
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      moveNode(activeViewId, node.id, initX + dx, initY + dy);
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  // Card bottom-right resizing
  const startNodeResize = (node: WorkspaceNode, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const initW = node.width;
    const initH = node.height;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!activeViewId) return;
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      resizeNode(
        activeViewId,
        node.id,
        Math.max(280, initW + dx),
        Math.max(150, initH + dy),
      );
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  return (
    <div className="relative flex h-full w-full bg-[#09090b] text-white">
      {/* ── Drag & Drop Snapshots Overlay ── */}
      {isDraggingSnapshot && (
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/85 backdrop-blur-md transition-all duration-300 pointer-events-auto"
          style={{ border: "2px dashed rgba(255,88,0,0.4)" }}
        >
          <Sparkles className="h-12 w-12 text-[#FF5800] animate-pulse mb-3" />
          <p className="text-base font-light text-white/80">
            Drop Workspace Snapshot here
          </p>
          <p className="text-xs text-white/30 mt-1">
            This will restore your active views and grid split positions
          </p>
        </div>
      )}

      {/* ── Main Canvas Area ── */}
      <div
        className="flex-1 flex flex-col h-full overflow-hidden"
        onDragOver={handleDragOver}
      >
        {/* Top Tab Bar (Tabs represent active workspaces) */}
        {hasTabs && (
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/[0.04] bg-zinc-950/20 backdrop-blur px-4 select-none z-20">
            <div className="flex items-center gap-2 overflow-x-auto scrollbar-none max-w-[80%] pr-4 h-full align-middle py-1">
              {safeViews.map((v) => {
                const isActive = v.id === activeViewId;
                const isEditing = editingTabId === v.id;

                // Use icon of first node inside this tab, or fallback to Grid icon
                const nodes = v.nodes || [];
                const TabIcon =
                  nodes.length > 0 ? getViewIcon(nodes[0].type) : Grid;

                return (
                  <div
                    key={v.id}
                    onClick={() => {
                      if (!isActive) {
                        useCanvasStore.getState().renameTab(v.id, v.name); // triggers focus update
                        useCanvasStore.setState({ activeViewId: v.id });
                      }
                    }}
                    onDoubleClick={() => {
                      setEditingTabId(v.id);
                      setEditingTabName(v.name);
                    }}
                    className={`group flex items-center gap-2 px-3.5 py-1.5 cursor-pointer text-xs rounded-full transition-all duration-300 relative glass-tab ${
                      isActive
                        ? "glass-tab-active text-[#FF5800]"
                        : "text-white/50 hover:text-white/80 hover:bg-white/[0.04]"
                    }`}
                  >
                    <TabIcon
                      className={`h-3.5 w-3.5 ${isActive ? "text-[#FF5800]" : "text-white/20"}`}
                    />

                    {isEditing ? (
                      <input
                        type="text"
                        value={editingTabName}
                        onChange={(e) => setEditingTabName(e.target.value)}
                        onBlur={() => {
                          if (editingTabName.trim()) {
                            renameTab(v.id, editingTabName.trim());
                          }
                          setEditingTabId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            if (editingTabName.trim()) {
                              renameTab(v.id, editingTabName.trim());
                            }
                            setEditingTabId(null);
                          }
                          if (e.key === "Escape") {
                            setEditingTabId(null);
                          }
                        }}
                        className="bg-zinc-900 border border-[#FF5800]/40 rounded px-1.5 py-0.5 text-xs text-white outline-none w-24"
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span className="font-medium">
                        {v.name.replace(/\.view$/, "")}
                      </span>
                    )}

                    <span className="text-[9px] font-mono text-white/20 px-1.5 py-0.5 bg-white/[0.04] rounded-full">
                      {nodes.length}
                    </span>

                    {/* Close Tab Button */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeView(v.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded-full text-white/20 hover:text-white/60 hover:bg-white/[0.06] transition-opacity ml-1"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                );
              })}

              {/* Add Tab Button */}
              <button
                type="button"
                onClick={() => addTab(`Workspace ${safeViews.length + 1}`)}
                className="p-1.5 rounded-full text-white/40 hover:text-white/80 hover:bg-white/[0.04] border border-white/5 transition-all ml-1 flex items-center justify-center"
                title="Create New Tab"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="text-[10px] font-mono text-white/25 pr-3 select-none">
              Double-click tab to rename
            </div>
          </div>
        )}

        {/* Node Graph Display Viewport */}
        <div
          onMouseDown={startPan}
          onWheel={handleWheel}
          className="flex-1 relative min-h-0 overflow-hidden select-none canvas-viewport pointer-events-auto"
        >
          {/* Panning background detection area */}
          <div
            className="absolute inset-0 pointer-events-none canvas-grid-bg"
            style={{
              backgroundPosition: `${panX}px ${panY}px`,
            }}
          />

          {/* Ambient background overlay — hints at what the agent can do */}
          <AmbientWords />

          {activeNodes.length === 0 ? (
            /* Empty state (no components generated yet) */
            <div
              className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none animate-fade-up"
              style={{
                animation: "fadeUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) both",
              }}
            >
              <p
                className="text-[15px] tracking-wide text-white/25"
                style={{
                  animation:
                    "fadeUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.1s both",
                }}
              >
                hey, {username}
              </p>
              <h1
                className="mt-3 text-center text-[28px] font-light leading-tight text-white/60"
                style={{
                  fontFamily: "'Caveat', cursive",
                  fontSize: "2.4rem",
                  letterSpacing: "-0.01em",
                  animation:
                    "fadeUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) 0.25s both",
                }}
              >
                what does your cloud look like today?
              </h1>
            </div>
          ) : (
            /* Main Node Space */
            <div className="absolute inset-0">
              {maximizedNode ? (
                /* Only render the maximized node as the focused view, sitting directly on the canvas */
                <ArtifactWindow
                  key={maximizedNode.id}
                  tabId={currentViewId}
                  node={maximizedNode}
                  onClose={() =>
                    handleCloseNodeAndNav(currentViewId, maximizedNode.id)
                  }
                  onMinimize={() =>
                    minimizeNode(
                      currentViewId,
                      maximizedNode.id,
                      !maximizedNode.isMinimized,
                    )
                  }
                  onMaximize={() =>
                    handleMaximizeNodeAndNav(
                      currentViewId,
                      maximizedNode.id,
                      false,
                    )
                  }
                  handleAction={handleAction}
                  onReload={() =>
                    runPrompt(
                      maximizedNode.type === "custom"
                        ? "regenerate view"
                        : `show ${maximizedNode.type}`,
                    )
                  }
                  onHeaderMouseDown={() => {}}
                  onResizeMouseDown={() => {}}
                  agentsQuery={agentsQuery}
                  apiKeysQuery={apiKeysQuery}
                  creditBalance={creditBalance}
                  genuiActionHandler={genuiActionHandler}
                  runPrompt={runPrompt}
                />
              ) : (
                /* Render all active nodes inside the panning container */
                <div
                  className="absolute inset-0 pointer-events-none"
                  style={{
                    transform: `translate(${panX}px, ${panY}px)`,
                  }}
                >
                  {activeNodes.map((node) => {
                    // Check if this is a chat-response node and if it is short
                    if (node.type === "chat-response") {
                      const text = node.content || "ok lets chat about this";
                      const words = text.trim().split(/\s+/);
                      const isShort = words.length <= 15;
                      if (isShort) {
                        let fontSize = "2.2rem";
                        if (words.length > 10) {
                          fontSize = "1.5rem";
                        } else if (words.length > 6) {
                          fontSize = "1.8rem";
                        }

                        return (
                          <div
                            key={node.id}
                            style={{
                              position: "absolute",
                              left: `${node.x}px`,
                              top: `${node.y}px`,
                              width: `${node.width}px`,
                              pointerEvents: "auto",
                            }}
                            className="flex flex-col items-center justify-center text-center select-none cursor-pointer hover:opacity-80 transition-opacity"
                            onClick={() => closeNode(currentViewId, node.id)}
                            title="Click to dismiss"
                          >
                            <h1
                              className="text-center font-light leading-tight text-[#FF5800]/90 select-text"
                              style={{
                                fontFamily: "'Caveat', cursive",
                                fontSize: fontSize,
                                letterSpacing: "-0.01em",
                                textShadow: "0 0 15px rgba(255, 88, 0, 0.15)",
                                animation:
                                  "fadeUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards",
                              }}
                            >
                              <StreamingText text={text} isShort />
                            </h1>
                          </div>
                        );
                      }
                    }

                    // Otherwise render it inside an ArtifactWindow container
                    return (
                      <ArtifactWindow
                        key={node.id}
                        tabId={currentViewId}
                        node={node}
                        onClose={() =>
                          handleCloseNodeAndNav(currentViewId, node.id)
                        }
                        onMinimize={() =>
                          minimizeNode(
                            currentViewId,
                            node.id,
                            !node.isMinimized,
                          )
                        }
                        onMaximize={() =>
                          handleMaximizeNodeAndNav(currentViewId, node.id, true)
                        }
                        handleAction={handleAction}
                        onReload={() =>
                          runPrompt(
                            node.type === "custom"
                              ? "regenerate view"
                              : `show ${node.type}`,
                          )
                        }
                        onHeaderMouseDown={(e) => startNodeDrag(node, e)}
                        onResizeMouseDown={(e) => startNodeResize(node, e)}
                        agentsQuery={agentsQuery}
                        apiKeysQuery={apiKeysQuery}
                        creditBalance={creditBalance}
                        genuiActionHandler={genuiActionHandler}
                        runPrompt={runPrompt}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div
        onMouseEnter={() => setSelectorHovered(true)}
        onMouseLeave={() => {
          setSelectorHovered(false);
          setIsSavingNewSnapshot(false);
          setNewSnapshotName("");
        }}
        className={`fixed bottom-0 left-0 right-0 z-40 transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
          selectorHovered ? "translate-y-0" : "translate-y-[calc(100%-24px)]"
        }`}
      >
        {/* Workspace dock container (now at the TOP of the sliding panel) */}
        <div
          className={`h-44 px-8 pt-1.5 pb-4 flex flex-col gap-3 pointer-events-auto select-none relative z-10 transition-all duration-500 ${
            selectorHovered
              ? "bg-[#08080c]/60 backdrop-blur-3xl border-t border-white/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.05),_0_-12px_40px_rgba(0,0,0,0.85)]"
              : "bg-[#08080c]/20 backdrop-blur-md border-t border-black/50 shadow-[inset_0_4px_12px_rgba(0,0,0,0.95),_0_-4px_20px_rgba(0,0,0,0.7)]"
          }`}
        >
          <div className="flex items-center justify-between px-2 relative z-30">
            <div className="flex items-center gap-4">
              <span className="text-[10px] font-bold tracking-widest text-white/40 uppercase font-mono leading-none">
                Workspace Selector
              </span>

              {/* Category tabs */}
              <div className="flex items-center gap-1 text-[9px] font-mono">
                <button
                  type="button"
                  onClick={() => setActiveSelectorTab("my")}
                  className={`px-2 py-0.5 rounded transition-all duration-200 ${
                    activeSelectorTab === "my"
                      ? "bg-white/10 text-white font-medium shadow-sm"
                      : "text-white/40 hover:text-white/70 hover:bg-white/5"
                  }`}
                >
                  My Snapshots
                </button>
                <button
                  type="button"
                  onClick={() => setActiveSelectorTab("templates")}
                  className={`px-2 py-0.5 rounded transition-all duration-200 ${
                    activeSelectorTab === "templates"
                      ? "bg-white/10 text-white font-medium shadow-sm"
                      : "text-white/40 hover:text-white/70 hover:bg-white/5"
                  }`}
                >
                  Templates
                </button>
                <button
                  type="button"
                  onClick={() => setActiveSelectorTab("community")}
                  className={`px-2 py-0.5 rounded transition-all duration-200 ${
                    activeSelectorTab === "community"
                      ? "bg-white/10 text-white font-medium shadow-sm"
                      : "text-white/40 hover:text-white/70 hover:bg-white/5"
                  }`}
                >
                  Community
                </button>
              </div>
            </div>
            <div className="flex items-center gap-1 z-30 select-none text-[9px] font-mono">
              {/* Account */}
              <button
                type="button"
                onClick={() => navigate("/dashboard/account")}
                title="Account settings"
                className="px-2 py-0.5 rounded transition-all duration-200 text-white/40 hover:text-white/70 hover:bg-white/5"
              >
                account
              </button>

              {/* Sign Out */}
              <button
                type="button"
                onClick={handleSignOut}
                title="Sign out of Eliza Cloud"
                className="px-2 py-0.5 rounded transition-all duration-200 text-white/40 hover:text-white/70 hover:bg-white/5"
              >
                sign out
              </button>
            </div>
          </div>

          {/* Horizontal Scroll Carousel with top padding and negative top margin to avoid overflow-y clipping and allow cards to render in front of container top */}
          <div className="flex-1 flex gap-5 overflow-x-auto scrollbar-none items-center px-4 pb-2 pt-8 -mt-6 carousel-perspective relative z-20">
            {/* 1. MY SNAPSHOTS */}
            {activeSelectorTab === "my" && (
              <>
                {snapshots.map((s) => {
                  const nodes = s.views[0]?.nodes || [];

                  return (
                    <div
                      key={s.id}
                      onClick={() => loadWorkspaceSnapshot(s.id)}
                      className="group relative flex-shrink-0 w-36 h-20 rounded-xl cursor-pointer transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] carousel-card border border-white/5 bg-white/[0.02] overflow-hidden"
                    >
                      {/* Visual preview map of nodes inside */}
                      <div className="absolute inset-0 p-1 flex items-center justify-center">
                        <div className="relative w-full h-full bg-black/55 rounded-lg overflow-hidden border border-white/5 flex items-center justify-center">
                          {nodes.length === 0 ? (
                            <span className="text-[8px] font-mono text-white/10 uppercase">
                              Empty Canvas
                            </span>
                          ) : (
                            nodes.map((node) => {
                              const scaleX = 0.055;
                              const scaleY = 0.035;
                              const left = Math.min(
                                Math.max(node.x * scaleX, 2),
                                110,
                              );
                              const top = Math.min(
                                Math.max(node.y * scaleY, 2),
                                60,
                              );
                              const w = Math.min(
                                Math.max(node.width * scaleX, 10),
                                60,
                              );
                              const h = Math.min(
                                Math.max(node.height * scaleY, 8),
                                40,
                              );
                              return (
                                <div
                                  key={node.id}
                                  style={{
                                    position: "absolute",
                                    left: `${left}px`,
                                    top: `${top}px`,
                                    width: `${w}px`,
                                    height: `${h}px`,
                                  }}
                                  className="rounded-sm bg-gradient-to-br from-[#FF5800]/40 to-amber-500/20 border border-white/10 shadow-[0_1px_2px_rgba(0,0,0,0.4)]"
                                />
                              );
                            })
                          )}
                        </div>
                      </div>

                      {/* Label Overlay */}
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-1.5 flex items-center justify-between">
                        <p className="truncate text-[10px] font-medium text-white/60 group-hover:text-white">
                          {s.name}
                        </p>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteWorkspaceSnapshot(s.id);
                          }}
                          className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-white/30 hover:text-red-400 hover:bg-white/5 transition-all"
                          title="Delete Snapshot"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}

                {/* Special "+ Save Current Layout" trigger card */}
                {hasTabs && (
                  <div className="flex-shrink-0 w-36 h-20 rounded-xl transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] carousel-card border border-dashed border-white/15 bg-white/[0.01] hover:border-[#FF5800]/40 flex flex-col items-center justify-center p-2 text-center group cursor-pointer relative">
                    {isSavingNewSnapshot ? (
                      <div
                        className="w-full flex flex-col gap-1.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="text"
                          placeholder="Name..."
                          value={newSnapshotName}
                          onChange={(e) => setNewSnapshotName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && newSnapshotName.trim()) {
                              saveWorkspaceSnapshot(newSnapshotName.trim());
                              setNewSnapshotName("");
                              setIsSavingNewSnapshot(false);
                            }
                            if (e.key === "Escape") {
                              setIsSavingNewSnapshot(false);
                            }
                          }}
                          className="bg-black/50 border border-white/10 rounded-md px-2 py-0.5 text-[10px] text-white placeholder-white/20 outline-none focus:border-[#FF5800]/50 w-full"
                        />
                        <div className="flex gap-1 justify-end">
                          <button
                            type="button"
                            onClick={() => setIsSavingNewSnapshot(false)}
                            className="px-1.5 py-0.5 text-[9px] text-white/50 hover:text-white rounded border border-white/5 hover:bg-white/5"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (newSnapshotName.trim()) {
                                saveWorkspaceSnapshot(newSnapshotName.trim());
                                setNewSnapshotName("");
                                setIsSavingNewSnapshot(false);
                              }
                            }}
                            className="px-1.5 py-0.5 text-[9px] bg-[#FF5800] text-black font-semibold rounded hover:bg-[#e04e00]"
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div
                        className="flex flex-col items-center justify-center w-full h-full"
                        onClick={() => setIsSavingNewSnapshot(true)}
                      >
                        <Plus className="h-5 w-5 text-white/30 group-hover:text-[#FF5800] group-hover:scale-110 transition-all duration-300 mb-1" />
                        <span className="text-[10px] font-mono text-white/40 group-hover:text-white/80 transition-colors">
                          Save Layout
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {/* 2. PREDEFINED WORKSPACE TEMPLATES */}
            {activeSelectorTab === "templates" &&
              WORKSPACE_TEMPLATES.map((t) => {
                const nodes = t.views[0]?.nodes || [];

                return (
                  <div
                    key={t.id}
                    onClick={() => loadTemplate(t)}
                    className="group relative flex-shrink-0 w-36 h-20 rounded-xl cursor-pointer transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] carousel-card border border-white/5 bg-white/[0.02] overflow-hidden"
                    title={t.description}
                  >
                    {/* Visual preview map of nodes inside */}
                    <div className="absolute inset-0 p-1 flex items-center justify-center">
                      <div className="relative w-full h-full bg-black/55 rounded-lg overflow-hidden border border-white/5 flex items-center justify-center">
                        {nodes.map((node) => {
                          const scaleX = 0.055;
                          const scaleY = 0.035;
                          const left = Math.min(
                            Math.max(node.x * scaleX, 2),
                            110,
                          );
                          const top = Math.min(
                            Math.max(node.y * scaleY, 2),
                            60,
                          );
                          const w = Math.min(
                            Math.max(node.width * scaleX, 10),
                            60,
                          );
                          const h = Math.min(
                            Math.max(node.height * scaleY, 8),
                            40,
                          );
                          return (
                            <div
                              key={node.id}
                              style={{
                                position: "absolute",
                                left: `${left}px`,
                                top: `${top}px`,
                                width: `${w}px`,
                                height: `${h}px`,
                              }}
                              className="rounded-sm bg-gradient-to-br from-[#FF5800]/40 to-amber-500/20 border border-white/10 shadow-[0_1px_2px_rgba(0,0,0,0.4)]"
                            />
                          );
                        })}
                      </div>
                    </div>

                    {/* Label Overlay */}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 to-black/35 p-1.5 flex flex-col gap-0.5 justify-end">
                      <p className="truncate text-[10px] font-semibold text-white/80 group-hover:text-white leading-none">
                        {t.name}
                      </p>
                      <p className="text-[7px] text-white/40 group-hover:text-white/60 truncate leading-none">
                        Starting template
                      </p>
                    </div>
                  </div>
                );
              })}

            {/* 3. COMMUNITY TEMPLATES */}
            {activeSelectorTab === "community" &&
              COMMUNITY_TEMPLATES.map((ct) => {
                const nodes = ct.views[0]?.nodes || [];

                return (
                  <div
                    key={ct.id}
                    onClick={() => loadTemplate(ct)}
                    className="group relative flex-shrink-0 w-36 h-20 rounded-xl cursor-pointer transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] carousel-card border border-white/5 bg-white/[0.02] overflow-hidden"
                    title={`${ct.name} by ${ct.creator} - ${ct.description}`}
                  >
                    {/* Visual preview map of nodes inside */}
                    <div className="absolute inset-0 p-1 flex items-center justify-center">
                      <div className="relative w-full h-full bg-black/55 rounded-lg overflow-hidden border border-white/5 flex items-center justify-center">
                        {nodes.map((node) => {
                          const scaleX = 0.055;
                          const scaleY = 0.035;
                          const left = Math.min(
                            Math.max(node.x * scaleX, 2),
                            110,
                          );
                          const top = Math.min(
                            Math.max(node.y * scaleY, 2),
                            60,
                          );
                          const w = Math.min(
                            Math.max(node.width * scaleX, 10),
                            60,
                          );
                          const h = Math.min(
                            Math.max(node.height * scaleY, 8),
                            40,
                          );
                          return (
                            <div
                              key={node.id}
                              style={{
                                position: "absolute",
                                left: `${left}px`,
                                top: `${top}px`,
                                width: `${w}px`,
                                height: `${h}px`,
                              }}
                              className="rounded-sm bg-gradient-to-br from-[#FF5800]/40 to-amber-500/20 border border-white/10 shadow-[0_1px_2px_rgba(0,0,0,0.4)]"
                            />
                          );
                        })}
                      </div>
                    </div>

                    {/* Label Overlay */}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 to-black/35 p-1.5 flex flex-col gap-0.5 justify-end">
                      <p className="truncate text-[10px] font-semibold text-white/80 group-hover:text-white leading-none">
                        {ct.name}
                      </p>
                      <p className="text-[7px] text-[#FF5800]/70 group-hover:text-[#FF5800] truncate leading-none font-medium">
                        {ct.creator}
                      </p>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>

        {/* VS Code Style Status Bar (now at the BOTTOM of the sliding panel, z-10) */}
        <div className="h-8 bg-[#050508]/95 backdrop-blur-md border-t border-white/[0.06] px-5 flex items-center justify-between text-white/50 text-[11px] font-mono select-none pointer-events-auto relative z-10">
          <div className="flex items-center gap-4">
            {/* Terminal Indicator */}
            <span
              onClick={() => openView("System Health", "health", null, null)}
              className="flex items-center gap-1.5 text-white/60 hover:text-white transition-colors cursor-pointer"
              title="Cloud API connection status"
            >
              <Terminal className="h-3.5 w-3.5 text-[#FF5800]" />
              <span className="font-bold text-[#FF5800]">&gt;&lt;</span>
              {isApiOffline ? (
                <span className="text-rose-500 font-medium animate-pulse">
                  api: offline
                </span>
              ) : (
                <span className="text-emerald-400 font-medium">
                  api: connected
                </span>
              )}
            </span>

            <span className="text-white/10 select-none">|</span>

            {/* Workspace Context */}
            <span className="flex items-center gap-1 text-white/60">
              <span className="text-white/30">workspace:</span>
              <span className="font-semibold text-[#FF5800] drop-shadow-[0_0_8px_rgba(255,88,0,0.2)]">
                {activeTab ? activeTab.name.replace(/\.view$/, "") : "none"}
              </span>
            </span>

            <span className="text-white/10 select-none">|</span>

            {/* Instances Counter */}
            <span
              onClick={() => openView("Instances", "agents", null, null)}
              className="flex items-center gap-1 text-white/60 hover:text-white transition-colors cursor-pointer"
              title="Active Instances"
            >
              <Bot className="h-3.5 w-3.5 text-sky-400" />
              <span>instances:</span>
              <span className="font-semibold text-white">
                {runningCount}/{agents.length}
              </span>
            </span>

            <span className="text-white/10 select-none">|</span>

            {/* API Keys Counter */}
            <span
              onClick={() => openView("API Keys", "apikeys", null, null)}
              className="flex items-center gap-1 text-white/60 hover:text-white transition-colors cursor-pointer"
              title="Active API Keys"
            >
              <Key className="h-3.5 w-3.5 text-amber-400" />
              <span>keys:</span>
              <span className="font-semibold text-white">
                {activeKeysCount}
              </span>
            </span>
          </div>

          <div className="flex items-center gap-4">
            {/* Credits Balance */}
            <span
              onClick={() => openView("Billing", "billing", null, null)}
              className="flex items-center gap-1.5 text-white/60 hover:text-white transition-colors cursor-pointer"
              title="Click to view billing details"
            >
              <CreditCard className="h-3.5 w-3.5 text-emerald-400" />
              <span>credits:</span>
              <span className="font-semibold text-emerald-400">
                ${balanceStr}
              </span>
            </span>

            <span className="text-white/10 select-none">|</span>

            {/* Active User / Profile */}
            <span
              onClick={() =>
                openView("Profile Overview", "profile", null, null)
              }
              className="hover:text-white text-white/60 transition-colors cursor-pointer truncate max-w-[120px]"
              title={`Logged in as ${user?.email || "guest"}`}
            >
              {user?.email ? user.email.split("@")[0] : "guest"}
            </span>

            <span className="text-white/10 select-none">|</span>

            <span
              onClick={() =>
                openView("Security Console", "security", null, null)
              }
              className="flex items-center gap-1.5 text-[#FF5800] hover:text-[#ff7426] transition-colors cursor-pointer font-semibold"
            >
              <Settings className="h-3.5 w-3.5 animate-spin [animation-duration:10s]" />
              <span>Eliza Cloud</span>
            </span>
          </div>
        </div>
      </div>

      {/* Embedded CSS Animations */}
      <style>{`
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes ambientFloat {
          0% {
            opacity: 0;
            transform: translateY(6px) rotate(var(--rot, 0deg));
          }
          12% {
            opacity: 0.12;
          }
          50% {
            opacity: 0.08;
            transform: translateY(-4px) rotate(var(--rot, 0deg));
          }
          88% {
            opacity: 0.12;
          }
          100% {
            opacity: 0;
            transform: translateY(-10px) rotate(var(--rot, 0deg));
          }
        }
        .ambient-word {
          position: absolute;
          font-family: 'Caveat', cursive;
          color: #FF5800;
          opacity: 0;
          white-space: nowrap;
          animation: ambientFloat var(--dur, 8s) ease-in-out var(--delay, 0s) forwards;
          will-change: opacity, transform;
          pointer-events: none;
          user-select: none;
        }

        /* ── Velvet Grey Canvas Viewport ── */
        .canvas-viewport {
          background: radial-gradient(circle at 50% 50%, #1e1e24 0%, #0e0e11 100%) !important;
          overflow: hidden;
          position: relative;
        }
        .canvas-viewport::before {
          content: '';
          position: absolute;
          inset: 0;
          background: radial-gradient(circle at 20% 30%, rgba(255, 255, 255, 0.02) 0%, transparent 50%),
                      radial-gradient(circle at 80% 70%, rgba(255, 88, 0, 0.01) 0%, transparent 60%);
          pointer-events: none;
        }

        /* ── Modern Liquid Glass Edgeless Card ── */
        .glass-card {
          background: linear-gradient(135deg, rgba(255, 255, 255, 0.05) 0%, rgba(255, 255, 255, 0.01) 100%);
          backdrop-filter: blur(28px) saturate(210%);
          -webkit-backdrop-filter: blur(28px) saturate(210%);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 20px;
          box-shadow: 
            0 30px 60px -15px rgba(0, 0, 0, 0.85),
            inset 0 1px 0 rgba(255, 255, 255, 0.18),
            0 0 0 1px rgba(255, 255, 255, 0.03);
          position: relative;
          transition: box-shadow 0.3s ease, border-color 0.3s ease;
        }
        .glass-card::after {
          content: '';
          position: absolute;
          inset: 0;
          border-radius: inherit;
          background: linear-gradient(135deg, rgba(255, 255, 255, 0.06) 0%, rgba(255, 255, 255, 0) 45%, rgba(255, 255, 255, 0) 100%);
          pointer-events: none;
          z-index: 5;
        }
        .glass-card:hover {
          border-color: rgba(255, 255, 255, 0.18);
          box-shadow: 
            0 35px 70px -12px rgba(0, 0, 0, 0.95),
            0 0 20px rgba(255, 88, 0, 0.05),
            inset 0 1px 0 rgba(255, 255, 255, 0.22);
        }

        .glass-header {
          background: linear-gradient(to bottom, rgba(255, 255, 255, 0.04) 0%, rgba(255, 255, 255, 0) 100%);
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
          z-index: 6;
        }
        .glass-footer {
          background: linear-gradient(to bottom, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0.02) 100%);
          border-top: 1px solid rgba(255, 255, 255, 0.06);
          z-index: 6;
        }
        .glass-content {
          background: linear-gradient(to bottom, rgba(0, 0, 0, 0.12), rgba(0, 0, 0, 0.25));
        }

        /* ── Glass Pill Buttons ── */
        .glass-button {
          background: linear-gradient(to bottom, rgba(255, 255, 255, 0.05) 0%, rgba(255, 255, 255, 0.01) 100%);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 6px;
          box-shadow: 
            0 1px 2px rgba(0, 0, 0, 0.2), 
            inset 0 1px 0 rgba(255, 255, 255, 0.04);
          transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .glass-button:hover {
          background: linear-gradient(to bottom, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.02) 100%);
          border-color: rgba(255, 255, 255, 0.12);
          box-shadow: 
            0 2px 4px rgba(0, 0, 0, 0.3), 
            inset 0 1px 0 rgba(255, 255, 255, 0.08);
          transform: translateY(-0.5px);
        }
        .glass-button:active {
          background: rgba(0, 0, 0, 0.3);
          border-color: rgba(255, 255, 255, 0.04);
          box-shadow: 
            inset 0 2px 4px rgba(0, 0, 0, 0.5), 
            0 0.5px 1px rgba(255, 255, 255, 0.02);
          transform: translateY(0.5px);
        }

        /* ── Glass Tabs ── */
        .glass-tab {
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 20px;
          padding: 6px 14px;
          transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
        }
        .glass-tab:hover {
          background: rgba(255, 255, 255, 0.05);
          border-color: rgba(255, 255, 255, 0.08);
        }
        .glass-tab-active {
          background: linear-gradient(to bottom, rgba(255, 255, 255, 0.08) 0%, rgba(255, 255, 255, 0.03) 100%);
          border: 1px solid rgba(255, 255, 255, 0.15);
          box-shadow: 
            0 4px 12px rgba(0, 0, 0, 0.25), 
            inset 0 1px 0 rgba(255, 255, 255, 0.05);
        }

        /* ── 3D Bottom Selector Carousel ── */
        .carousel-perspective {
          perspective: 1000px;
        }
        .carousel-card {
          transform: rotateX(12deg) rotateY(-6deg);
          transform-style: preserve-3d;
          box-shadow: 
            0 12px 24px rgba(0, 0, 0, 0.6), 
            inset 0 1px 0 rgba(255, 255, 255, 0.05);
          transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
          transform-origin: center bottom;
        }
        .carousel-card:hover {
          transform: rotateX(0deg) rotateY(0deg) scale(1.16) translateY(-8px);
          border-color: rgba(255, 88, 0, 0.4);
          box-shadow: 
            0 20px 40px rgba(0, 0, 0, 0.85),
            0 0 20px rgba(255, 88, 0, 0.2),
            inset 0 1px 0 rgba(255, 255, 255, 0.12);
          z-index: 10;
        }

        /* ── Input Fields Form Overrides ── */
        .glass-card input,
        .glass-card select,
        .glass-card textarea {
          background: rgba(0, 0, 0, 0.3) !important;
          border: 1px solid rgba(255, 255, 255, 0.08) !important;
          border-radius: 10px !important;
          color: #e4e4e7 !important;
          padding: 8px 12px !important;
          font-size: 13px !important;
          transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1) !important;
          box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.6) !important;
        }
        .glass-card input:focus,
        .glass-card select:focus,
        .glass-card textarea:focus {
          border-color: rgba(255, 88, 0, 0.5) !important;
          background: rgba(0, 0, 0, 0.4) !important;
          box-shadow: 
            inset 0 2px 4px rgba(0, 0, 0, 0.7),
            0 0 14px rgba(255, 88, 0, 0.18) !important;
          outline: none !important;
        }

        /* Glass styled buttons inside forms */
        .glass-card button:not(.glass-button):not(.overlay-action-btn):not(.traffic-light-btn):not(.tab-btn):not(.icon-btn):not(.badge-btn):not(.action-btn) {
          background: linear-gradient(to bottom, rgba(255, 88, 0, 0.85) 0%, rgba(224, 78, 0, 0.95) 100%) !important;
          border: 1px solid #7c2d12 !important;
          border-radius: 10px !important;
          color: #000 !important;
          font-weight: 600 !important;
          box-shadow: 
            0 2px 4px rgba(0, 0, 0, 0.3), 
            inset 0 1px 0 rgba(255, 255, 255, 0.2) !important;
          transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1) !important;
        }
        .glass-card button:not(.glass-button):not(.overlay-action-btn):not(.traffic-light-btn):not(.tab-btn):not(.icon-btn):not(.badge-btn):not(.action-btn):hover {
          background: linear-gradient(to bottom, rgba(255, 98, 15, 0.95) 0%, rgba(240, 85, 0, 1) 100%) !important;
          box-shadow: 
            0 4px 8px rgba(0, 0, 0, 0.4), 
            inset 0 1px 0 rgba(255, 255, 255, 0.3) !important;
          transform: translateY(-0.5px);
        }
        .glass-card button:not(.glass-button):not(.overlay-action-btn):not(.traffic-light-btn):not(.tab-btn):not(.icon-btn):not(.badge-btn):not(.action-btn):active {
          background: #c2410c !important;
          box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.8) !important;
          transform: translateY(0.5px);
        }

        /* ── Floating Overlay Actions ── */
        .overlay-action-btn {
          height: 24px !important;
          padding: 0 8px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
          font-family: inherit;
          font-size: 10px;
          font-weight: 500;
          border-radius: 9999px !important;
          transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
          cursor: pointer;
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
        }
        
        .btn-copy {
          background: rgba(99, 102, 241, 0.12) !important;
          border: 1px solid rgba(99, 102, 241, 0.25) !important;
          color: #a5b4fc !important;
          font-weight: 500 !important;
          box-shadow: 0 2px 8px rgba(99, 102, 241, 0.15) !important;
        }
        .btn-copy:hover {
          background: rgba(99, 102, 241, 0.22) !important;
          border-color: rgba(99, 102, 241, 0.45) !important;
          color: #c7d2fe !important;
          box-shadow: 0 0 12px rgba(99, 102, 241, 0.35) !important;
          transform: translateY(-1px) !important;
        }
        .btn-copy:active {
          background: rgba(99, 102, 241, 0.32) !important;
          transform: translateY(0.5px) !important;
        }
        .btn-copy-active {
          background: rgba(99, 102, 241, 0.3) !important;
          border: 1px solid rgba(99, 102, 241, 0.6) !important;
          color: #c7d2fe !important;
          box-shadow: 0 0 14px rgba(99, 102, 241, 0.5) !important;
          font-weight: 500 !important;
        }
        
        .btn-like {
          background: rgba(16, 185, 129, 0.12) !important;
          border: 1px solid rgba(16, 185, 129, 0.25) !important;
          color: #6ee7b7 !important;
          width: 24px !important;
          padding: 0 !important;
          box-shadow: 0 2px 8px rgba(16, 185, 129, 0.15) !important;
        }
        .btn-like:hover {
          background: rgba(16, 185, 129, 0.22) !important;
          border-color: rgba(16, 185, 129, 0.45) !important;
          color: #a7f3d0 !important;
          box-shadow: 0 0 12px rgba(16, 185, 129, 0.35) !important;
          transform: translateY(-1px) !important;
        }
        .btn-like:active {
          background: rgba(16, 185, 129, 0.32) !important;
          transform: translateY(0.5px) !important;
        }
        .btn-like-active {
          background: rgba(16, 185, 129, 0.3) !important;
          border: 1px solid rgba(16, 185, 129, 0.6) !important;
          color: #a7f3d0 !important;
          box-shadow: 0 0 14px rgba(16, 185, 129, 0.5) !important;
          width: 24px !important;
          padding: 0 !important;
        }
        
        .btn-dislike {
          background: rgba(244, 63, 94, 0.12) !important;
          border: 1px solid rgba(244, 63, 94, 0.25) !important;
          color: #fca5a5 !important;
          width: 24px !important;
          padding: 0 !important;
          box-shadow: 0 2px 8px rgba(244, 63, 94, 0.15) !important;
        }
        .btn-dislike:hover {
          background: rgba(244, 63, 94, 0.22) !important;
          border-color: rgba(244, 63, 94, 0.45) !important;
          color: #fecaca !important;
          box-shadow: 0 0 12px rgba(244, 63, 94, 0.35) !important;
          transform: translateY(-1px) !important;
        }
        .btn-dislike:active {
          background: rgba(244, 63, 94, 0.32) !important;
          transform: translateY(0.5px) !important;
        }
        .btn-dislike-active {
          background: rgba(244, 63, 94, 0.3) !important;
          border: 1px solid rgba(244, 63, 94, 0.6) !important;
          color: #fecaca !important;
          box-shadow: 0 0 14px rgba(244, 63, 94, 0.5) !important;
          width: 24px !important;
          padding: 0 !important;
        }
        
        .btn-comment {
          background: rgba(14, 165, 233, 0.12) !important;
          border: 1px solid rgba(14, 165, 233, 0.25) !important;
          color: #7dd3fc !important;
          width: 24px !important;
          padding: 0 !important;
          box-shadow: 0 2px 8px rgba(14, 165, 233, 0.15) !important;
        }
        .btn-comment:hover {
          background: rgba(14, 165, 233, 0.22) !important;
          border-color: rgba(14, 165, 233, 0.45) !important;
          color: #bae6fd !important;
          box-shadow: 0 0 12px rgba(14, 165, 233, 0.35) !important;
          transform: translateY(-1px) !important;
        }
        .btn-comment:active {
          background: rgba(14, 165, 233, 0.32) !important;
          transform: translateY(0.5px) !important;
        }
        
        .btn-share {
          background: rgba(249, 115, 22, 0.12) !important;
          border: 1px solid rgba(249, 115, 22, 0.25) !important;
          color: #ffedd5 !important;
          width: 24px !important;
          padding: 0 !important;
          box-shadow: 0 2px 8px rgba(249, 115, 22, 0.15) !important;
        }
        .btn-share:hover {
          background: rgba(249, 115, 22, 0.22) !important;
          border-color: rgba(249, 115, 22, 0.45) !important;
          color: #fff !important;
          box-shadow: 0 0 12px rgba(249, 115, 22, 0.35) !important;
          transform: translateY(-1px) !important;
        }
        .btn-share:active {
          background: rgba(249, 115, 22, 0.32) !important;
          transform: translateY(0.5px) !important;
        }

        /* ── Dynamic DNA Loader ── */
        .dna-container {
          display: flex;
          flex-direction: row;
          gap: 12px;
          justify-content: center;
          align-items: center;
          perspective: 1000px;
          height: 100%;
          min-height: 80px;
          user-select: none;
        }

        .dna-node {
          position: relative;
          width: 24px;
          height: 36px;
          transform-style: preserve-3d;
          animation: dna-rotate 2.4s linear infinite;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        @keyframes dna-rotate {
          0% {
            transform: rotateY(0deg);
          }
          100% {
            transform: rotateY(360deg);
          }
        }

        .dna-letter {
          position: absolute;
          font-family: "Quicksand", "Outfit", "Inter", sans-serif;
          font-weight: 700;
          font-size: 14px;
          line-height: 1;
          color: #fff;
          backface-visibility: visible;
          text-shadow: 0 0 8px rgba(255, 255, 255, 0.4);
          transform-origin: center center;
          top: 50%;
          left: 50%;
        }

        .dna-letter-left {
          animation: dna-unrotate-left 2.4s linear infinite;
        }

        .dna-letter-right {
          animation: dna-unrotate-right 2.4s linear infinite;
        }

        @keyframes dna-unrotate-left {
          0% {
            transform: translate(-50%, -50%) translateX(-22px) rotateY(0deg);
            opacity: 1;
          }
          25% {
            opacity: 0.6;
          }
          50% {
            transform: translate(-50%, -50%) translateX(-22px) rotateY(-180deg);
            opacity: 0.35;
          }
          75% {
            opacity: 0.6;
          }
          100% {
            transform: translate(-50%, -50%) translateX(-22px) rotateY(-360deg);
            opacity: 1;
          }
        }

        @keyframes dna-unrotate-right {
          0% {
            transform: translate(-50%, -50%) translateX(22px) rotateY(0deg);
            opacity: 0.35;
          }
          25% {
            opacity: 0.6;
          }
          50% {
            transform: translate(-50%, -50%) translateX(22px) rotateY(-180deg);
            opacity: 1;
          }
          75% {
            opacity: 0.6;
          }
          100% {
            transform: translate(-50%, -50%) translateX(22px) rotateY(-360deg);
            opacity: 0.35;
          }
        }

        .dna-line {
          position: absolute;
          height: 1.5px;
          border-radius: 999px;
          width: 44px;
          transform: translate(-50%, -50%);
          left: 50%;
          top: 50%;
          transform-origin: center center;
          animation: dna-line-scale 2.4s linear infinite;
          box-shadow: 0 0 10px var(--glow-color);
        }

        @keyframes dna-line-scale {
          0%, 50%, 100% {
            transform: translate(-50%, -50%) scaleX(1);
          }
          25%, 75% {
            transform: translate(-50%, -50%) scaleX(0);
          }
        }
      `}</style>
    </div>
  );
}
