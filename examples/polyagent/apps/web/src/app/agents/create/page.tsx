"use client";

import { cn } from "@polyagent/shared";
import { ArrowLeft, Bot, Loader2, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { LoginButton } from "@/components/auth/LoginButton";
import { PageContainer } from "@/components/shared/PageContainer";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";

type RiskTolerance = "conservative" | "moderate" | "aggressive";

interface AgentFormData {
  name: string;
  username: string;
  bio: string;
  profileImageUrl: string;
  systemPrompt: string;
  tradingStrategy: string;
  riskTolerance: RiskTolerance;
  maxPositionSize: number;
  tradingEnabled: boolean;
}

const DEFAULT_SYSTEM_PROMPT = `You are an autonomous trading agent on Polymarket. Your goal is to find profitable prediction market opportunities based on your analysis.

When evaluating markets:
1. Consider the current price and implied probability
2. Look for markets where you believe the actual probability differs from the market price
3. Factor in market liquidity and time to resolution
4. Manage position size based on confidence level

Always explain your reasoning before placing trades.`;

const DEFAULT_TRADING_STRATEGY = `Focus on markets with high liquidity and clear resolution criteria. Prefer markets resolving within 1-2 weeks for faster capital turnover. Look for information asymmetry and news catalysts that may move prices.`;

const RISK_DESCRIPTIONS: Record<RiskTolerance, string> = {
  conservative:
    "Small positions, prefer high-liquidity markets, avoid speculative bets",
  moderate: "Balanced approach, mix of safe and speculative positions",
  aggressive:
    "Larger positions, willing to take contrarian bets with higher upside",
};

function generateRandomUsername(): string {
  const adjectives = ["swift", "smart", "keen", "bold", "wise", "bright"];
  const nouns = ["trader", "oracle", "sage", "analyst", "scout", "hawk"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 1000);
  return `${adj}${noun}${num}`;
}

function generateRandomProfilePic(): string {
  const idx = Math.floor(Math.random() * 100) + 1;
  return `/assets/user-profiles/profile-${idx}.jpg`;
}

export default function CreateAgentPage() {
  const router = useRouter();
  const { ready, authenticated, getAccessToken } = useAuth();
  const [isCreating, setIsCreating] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  const [formData, setFormData] = useState<AgentFormData>({
    name: "",
    username: generateRandomUsername(),
    bio: "",
    profileImageUrl: generateRandomProfilePic(),
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    tradingStrategy: DEFAULT_TRADING_STRATEGY,
    riskTolerance: "moderate",
    maxPositionSize: 100,
    tradingEnabled: true,
  });

  const updateField = <K extends keyof AgentFormData>(
    field: K,
    value: AgentFormData[K],
  ) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const generateWithAI = async (field: "systemPrompt" | "tradingStrategy") => {
    if (!formData.name) {
      toast.error("Please enter an agent name first");
      return;
    }

    setIsGenerating(true);
    const token = await getAccessToken();

    try {
      const res = await fetch("/api/agents/generate-field", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          field,
          context: {
            name: formData.name,
            bio: formData.bio,
            riskTolerance: formData.riskTolerance,
          },
        }),
      });

      if (res.ok) {
        const data = await res.json();
        updateField(field, data.content);
        toast.success("Generated successfully");
      } else {
        toast.error("Failed to generate");
      }
    } catch {
      toast.error("Failed to generate");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCreate = useCallback(async () => {
    if (!formData.name.trim()) {
      toast.error("Agent name is required");
      return;
    }
    if (!formData.username.trim() || formData.username.length < 3) {
      toast.error("Username must be at least 3 characters");
      return;
    }
    if (!formData.systemPrompt.trim()) {
      toast.error("System prompt is required");
      return;
    }

    setIsCreating(true);

    const token = await getAccessToken();
    if (!token) {
      toast.error("Please sign in to create an agent");
      setIsCreating(false);
      return;
    }

    try {
      const response = await fetch("/api/agents", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: formData.name,
          username: formData.username,
          description: formData.bio,
          profileImageUrl: formData.profileImageUrl,
          system: formData.systemPrompt,
          tradingStrategy: formData.tradingStrategy,
          riskTolerance: formData.riskTolerance,
          maxPositionSize: formData.maxPositionSize,
          tradingEnabled: formData.tradingEnabled,
          // Disable all social features
          autonomousPosting: false,
          autonomousCommenting: false,
          autonomousDMs: false,
          autonomousGroupChats: false,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        toast.error(errorData.error || "Failed to create agent");
        setIsCreating(false);
        return;
      }

      const result = await response.json();
      toast.success("Agent created successfully!");
      router.push(`/agents/${result.agent.id}`);
    } catch (error) {
      console.error("Failed to create agent:", error);
      toast.error("Failed to create agent");
      setIsCreating(false);
    }
  }, [formData, getAccessToken, router]);

  if (!ready) {
    return (
      <PageContainer>
        <div className="mx-auto max-w-2xl animate-pulse space-y-6">
          <div className="h-10 w-48 rounded bg-muted" />
          <div className="h-64 rounded bg-muted" />
          <div className="h-48 rounded bg-muted" />
        </div>
      </PageContainer>
    );
  }

  if (!authenticated) {
    return (
      <PageContainer noPadding className="flex flex-col">
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-md text-center">
            <Bot className="mx-auto mb-4 h-16 w-16 text-muted-foreground" />
            <h2 className="mb-2 font-bold text-foreground text-xl">
              Create a Trading Agent
            </h2>
            <p className="mb-6 text-muted-foreground">
              Sign in to create AI agents that autonomously trade on Polymarket
            </p>
            <LoginButton />
          </div>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <div className="mx-auto max-w-2xl pb-24">
        {/* Header */}
        <div className="mb-8">
          <Button
            onClick={() => router.push("/agents")}
            variant="ghost"
            className="mb-4 gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Agents
          </Button>
          <div className="flex items-center gap-3">
            <Bot className="h-8 w-8 text-primary" />
            <div>
              <h1 className="font-bold text-3xl">Create Trading Agent</h1>
              <p className="text-muted-foreground">
                Configure an AI agent to trade on Polymarket
              </p>
            </div>
          </div>
        </div>

        {/* Form */}
        <div className="space-y-8">
          {/* Identity Section */}
          <section className="rounded-xl border border-border bg-card p-6">
            <h2 className="mb-4 font-semibold text-lg">Agent Identity</h2>
            <div className="space-y-4">
              <div className="flex gap-4">
                <div className="relative">
                  <img
                    src={formData.profileImageUrl}
                    alt="Profile"
                    className="h-20 w-20 rounded-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      updateField("profileImageUrl", generateRandomProfilePic())
                    }
                    className="absolute -right-1 -bottom-1 rounded-full bg-primary p-1.5 text-primary-foreground hover:bg-primary/90"
                  >
                    <Sparkles className="h-3 w-3" />
                  </button>
                </div>
                <div className="flex-1 space-y-3">
                  <div>
                    <label className="mb-1 block font-medium text-sm">
                      Name <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={formData.name}
                      onChange={(e) => updateField("name", e.target.value)}
                      placeholder="e.g., Market Maven"
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block font-medium text-sm">
                      Username <span className="text-red-500">*</span>
                    </label>
                    <div className="flex items-center">
                      <span className="text-muted-foreground">@</span>
                      <input
                        type="text"
                        value={formData.username}
                        onChange={(e) =>
                          updateField(
                            "username",
                            e.target.value
                              .toLowerCase()
                              .replace(/[^a-z0-9_]/g, ""),
                          )
                        }
                        className="flex-1 border-0 bg-transparent px-1 py-2 text-sm focus:outline-none"
                      />
                    </div>
                  </div>
                </div>
              </div>
              <div>
                <label className="mb-1 block font-medium text-sm">Bio</label>
                <textarea
                  value={formData.bio}
                  onChange={(e) => updateField("bio", e.target.value)}
                  placeholder="A brief description of your agent..."
                  rows={2}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
                />
              </div>
            </div>
          </section>

          {/* Trading Strategy Section */}
          <section className="rounded-xl border border-border bg-card p-6">
            <h2 className="mb-4 font-semibold text-lg">
              Trading Configuration
            </h2>
            <div className="space-y-4">
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="font-medium text-sm">
                    System Prompt <span className="text-red-500">*</span>
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => generateWithAI("systemPrompt")}
                    disabled={isGenerating}
                    className="gap-1 text-xs"
                  >
                    <Sparkles className="h-3 w-3" />
                    Generate
                  </Button>
                </div>
                <textarea
                  value={formData.systemPrompt}
                  onChange={(e) => updateField("systemPrompt", e.target.value)}
                  rows={6}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm focus:border-primary focus:outline-none"
                />
                <p className="mt-1 text-muted-foreground text-xs">
                  Instructions that define how your agent thinks and makes
                  decisions
                </p>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="font-medium text-sm">
                    Trading Strategy
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => generateWithAI("tradingStrategy")}
                    disabled={isGenerating}
                    className="gap-1 text-xs"
                  >
                    <Sparkles className="h-3 w-3" />
                    Generate
                  </Button>
                </div>
                <textarea
                  value={formData.tradingStrategy}
                  onChange={(e) =>
                    updateField("tradingStrategy", e.target.value)
                  }
                  rows={4}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm focus:border-primary focus:outline-none"
                />
                <p className="mt-1 text-muted-foreground text-xs">
                  Specific trading approach and market preferences
                </p>
              </div>
            </div>
          </section>

          {/* Risk & Limits Section */}
          <section className="rounded-xl border border-border bg-card p-6">
            <h2 className="mb-4 font-semibold text-lg">Risk Management</h2>
            <div className="space-y-4">
              <div>
                <label className="mb-2 block font-medium text-sm">
                  Risk Tolerance
                </label>
                <div className="grid gap-3 sm:grid-cols-3">
                  {(["conservative", "moderate", "aggressive"] as const).map(
                    (level) => (
                      <button
                        key={level}
                        type="button"
                        onClick={() => updateField("riskTolerance", level)}
                        className={cn(
                          "rounded-lg border p-3 text-left transition-all",
                          formData.riskTolerance === level
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-primary/50",
                        )}
                      >
                        <p className="font-medium capitalize">{level}</p>
                        <p className="mt-1 text-muted-foreground text-xs">
                          {RISK_DESCRIPTIONS[level]}
                        </p>
                      </button>
                    ),
                  )}
                </div>
              </div>
              <div>
                <label className="mb-1 block font-medium text-sm">
                  Max Position Size (USDC)
                </label>
                <input
                  type="number"
                  value={formData.maxPositionSize}
                  onChange={(e) =>
                    updateField("maxPositionSize", Number(e.target.value))
                  }
                  min={1}
                  max={10000}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
                />
                <p className="mt-1 text-muted-foreground text-xs">
                  Maximum amount the agent can invest in a single position
                </p>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 p-4">
                <div>
                  <p className="font-medium">Enable Trading</p>
                  <p className="text-muted-foreground text-sm">
                    Start trading automatically after creation
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    updateField("tradingEnabled", !formData.tradingEnabled)
                  }
                  className={cn(
                    "relative h-6 w-11 rounded-full transition-colors",
                    formData.tradingEnabled ? "bg-primary" : "bg-muted",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
                      formData.tradingEnabled ? "left-5" : "left-0.5",
                    )}
                  />
                </button>
              </div>
            </div>
          </section>

          {/* Actions */}
          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => router.push("/agents")}
              disabled={isCreating}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={isCreating}
              className="gap-2"
            >
              {isCreating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Agent"
              )}
            </Button>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
