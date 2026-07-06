"use client";

/**
 * Promote App Dialog
 *
 * A comprehensive promotion wizard that allows users to:
 * - Select promotion channels (social, SEO, advertising)
 * - Configure platform-specific settings
 * - Preview and launch promotions
 * - Track promotion status
 */

import type { LucideIcon } from "lucide-react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  AtSign,
  Bird,
  Braces,
  Briefcase,
  Check,
  CheckCircle,
  FileText,
  Gamepad2,
  Loader2,
  Megaphone,
  Search,
  Send,
  Share2,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "../primitives";

interface PromoteAppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  app: {
    id: string;
    name: string;
    description?: string;
    app_url: string;
  };
  adAccounts?: Array<{
    id: string;
    platform: string;
    accountName: string;
  }>;
}

type PromotionChannel = "social" | "seo" | "advertising";
type CampaignBidStrategy = "cpm" | "cpc" | "cpa";
type CampaignOptimizationGoal = "reach" | "clicks" | "conversions";

interface PromotionConfig {
  channels: PromotionChannel[];
  social?: {
    platforms: string[];
    customMessage?: string;
  };
  seo?: {
    generateMeta: boolean;
    generateSchema: boolean;
    submitToIndexNow: boolean;
  };
  advertising?: {
    platform: string;
    adAccountId: string;
    budget: number;
    budgetType: "daily" | "lifetime";
    objective: string;
    bidStrategy?: CampaignBidStrategy;
    optimizationGoal?: CampaignOptimizationGoal;
    duration?: number;
    audienceSegmentId?: string;
  };
}

interface AudienceSegmentOption {
  id: string;
  name: string;
  description?: string | null;
}

const SOCIAL_PLATFORMS: Array<{
  id: string;
  name: string;
  Icon: LucideIcon;
}> = [
  { id: "twitter", name: "Twitter/X", Icon: AtSign },
  { id: "bluesky", name: "Bluesky", Icon: Bird },
  { id: "linkedin", name: "LinkedIn", Icon: Briefcase },
  { id: "facebook", name: "Facebook", Icon: Users },
  { id: "discord", name: "Discord", Icon: Gamepad2 },
  { id: "telegram", name: "Telegram", Icon: Send },
];

const AD_OBJECTIVES = [
  {
    id: "awareness",
    name: "Brand Awareness",
    description: "Reach new audiences",
  },
  {
    id: "traffic",
    name: "Website Traffic",
    description: "Drive visits to your app",
  },
  {
    id: "engagement",
    name: "Engagement",
    description: "Get likes, comments, shares",
  },
  {
    id: "app_promotion",
    name: "App Installs",
    description: "Promote app downloads",
  },
];

const BID_STRATEGIES: Array<{ id: CampaignBidStrategy; name: string }> = [
  { id: "cpm", name: "CPM" },
  { id: "cpc", name: "CPC" },
  { id: "cpa", name: "CPA" },
];

const OPTIMIZATION_GOALS: Array<{
  id: CampaignOptimizationGoal;
  name: string;
}> = [
  { id: "reach", name: "Reach" },
  { id: "clicks", name: "Clicks" },
  { id: "conversions", name: "Conversions" },
];

export function PromoteAppDialog({
  open,
  onOpenChange,
  app,
  adAccounts = [],
}: PromoteAppDialogProps) {
  const [step, setStep] = useState<
    "channels" | "configure" | "review" | "result"
  >("channels");
  const [activeTab, setActiveTab] = useState<PromotionChannel>("social");
  const [isLoading, setIsLoading] = useState(false);
  const [config, setConfig] = useState<PromotionConfig>({ channels: [] });
  const [audienceSegments, setAudienceSegments] = useState<
    AudienceSegmentOption[]
  >([]);
  const [result, setResult] = useState<{
    success: boolean;
    channels: Record<string, { success: boolean; error?: string }>;
    totalCreditsUsed: number;
  } | null>(null);
  const getAdvertisingConfig = useCallback(
    (prev: PromotionConfig) =>
      prev.advertising ?? {
        platform: adAccounts[0]?.platform ?? "meta",
        adAccountId: adAccounts[0]?.id ?? "",
        budget: 10,
        budgetType: "daily" as const,
        objective: "traffic",
        bidStrategy: "cpm" as const,
        optimizationGoal: "reach" as const,
      },
    [adAccounts],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    async function loadAudienceSegments() {
      try {
        const response = await fetch("/api/v1/advertising/audience-segments");
        if (!response.ok) return;
        const data = (await response.json()) as {
          segments?: AudienceSegmentOption[];
        };
        if (!cancelled) {
          setAudienceSegments(data.segments ?? []);
        }
      } catch {
        if (!cancelled) {
          setAudienceSegments([]);
        }
      }
    }

    void loadAudienceSegments();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const toggleChannel = (channel: PromotionChannel) => {
    setConfig((prev) => ({
      ...prev,
      channels: prev.channels.includes(channel)
        ? prev.channels.filter((c) => c !== channel)
        : [...prev.channels, channel],
    }));
  };

  const toggleSocialPlatform = (platformId: string) => {
    setConfig((prev) => ({
      ...prev,
      social: {
        ...prev.social,
        platforms: prev.social?.platforms?.includes(platformId)
          ? prev.social.platforms.filter((p) => p !== platformId)
          : [...(prev.social?.platforms || []), platformId],
      },
    }));
  };

  const handlePromote = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/v1/apps/${app.id}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = await response.json();

      if (response.ok) {
        setResult({
          success: data.errors?.length === 0,
          channels: {
            social: data.channels?.social,
            seo: data.channels?.seo,
            advertising: data.channels?.advertising,
          },
          totalCreditsUsed: data.totalCreditsUsed,
        });
        setStep("result");
        toast.success("Promotion launched!");
      } else {
        toast.error(data.error || "Failed to launch promotion");
      }
    } catch {
      toast.error("Failed to launch promotion. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }, [app.id, config]);

  const handleClose = () => {
    setStep("channels");
    setConfig({ channels: [] });
    setResult(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl bg-card border-border p-0 overflow-hidden">
        <DialogHeader className="p-6 pb-0">
          <DialogTitle className="text-txt text-lg font-medium">
            Promote {app.name}
          </DialogTitle>
          <p className="text-sm text-muted mt-1">
            Launch your app across multiple channels to reach more users
          </p>
        </DialogHeader>

        <div className="p-6 pt-4">
          {/* Step: Channels */}
          {step === "channels" && (
            <div className="space-y-3">
              {/* Social */}
              <Button
                variant="ghost"
                type="button"
                onClick={() => toggleChannel("social")}
                className={`w-full flex items-center gap-4 p-4 rounded-sm border transition-all text-left group ${
                  config.channels.includes("social")
                    ? "border-accent/50 bg-accent-subtle"
                    : "border-border bg-bg-elevated hover:bg-bg-hover hover:border-border-strong"
                }`}
              >
                <Share2
                  className={`h-6 w-6 ${config.channels.includes("social") ? "text-accent" : "text-muted"}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-txt">Social Media</span>
                    <span
                      className={`px-2 py-0.5 rounded-sm text-2xs ${
                        config.channels.includes("social")
                          ? "bg-accent-subtle text-accent"
                          : "bg-bg-hover text-muted"
                      }`}
                    >
                      ~$0.02/post
                    </span>
                  </div>
                  <p className="text-sm text-muted mt-0.5">
                    Post to Twitter, LinkedIn, Discord...
                  </p>
                </div>
                <div
                  className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    config.channels.includes("social")
                      ? "border-accent bg-accent"
                      : "border-border-strong"
                  }`}
                >
                  {config.channels.includes("social") && (
                    <Check className="h-3 w-3 text-accent-foreground" />
                  )}
                </div>
              </Button>

              {/* SEO */}
              <Button
                variant="ghost"
                type="button"
                onClick={() => toggleChannel("seo")}
                className={`w-full flex items-center gap-4 p-4 rounded-sm border transition-all text-left group ${
                  config.channels.includes("seo")
                    ? "border-status-success/50 bg-status-success-bg"
                    : "border-border bg-bg-elevated hover:bg-bg-hover hover:border-border-strong"
                }`}
              >
                <Search
                  className={`h-6 w-6 ${config.channels.includes("seo") ? "text-status-success" : "text-muted"}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-txt">SEO</span>
                    <span
                      className={`px-2 py-0.5 rounded-sm text-2xs ${
                        config.channels.includes("seo")
                          ? "bg-status-success-bg text-status-success"
                          : "bg-bg-hover text-muted"
                      }`}
                    >
                      ~$0.03
                    </span>
                  </div>
                  <p className="text-sm text-muted mt-0.5">
                    Optimize for search engines
                  </p>
                </div>
                <div
                  className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    config.channels.includes("seo")
                      ? "border-status-success bg-status-success"
                      : "border-border-strong"
                  }`}
                >
                  {config.channels.includes("seo") && (
                    <Check className="h-3 w-3 text-[var(--brand-white)]" />
                  )}
                </div>
              </Button>

              {/* Advertising */}
              <Button
                variant="ghost"
                type="button"
                onClick={() =>
                  adAccounts.length > 0 && toggleChannel("advertising")
                }
                className={`w-full flex items-center gap-4 p-4 rounded-sm border transition-all text-left group ${
                  config.channels.includes("advertising")
                    ? "border-accent/50 bg-accent-subtle"
                    : adAccounts.length === 0
                      ? "border-border bg-bg-elevated opacity-60 cursor-not-allowed"
                      : "border-border bg-bg-elevated hover:bg-bg-hover hover:border-border-strong"
                }`}
              >
                <Megaphone
                  className={`h-6 w-6 ${
                    config.channels.includes("advertising")
                      ? "text-accent"
                      : adAccounts.length === 0
                        ? "text-muted"
                        : "text-muted"
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`font-medium ${adAccounts.length === 0 ? "text-muted" : "text-txt"}`}
                    >
                      Advertising
                    </span>
                    {adAccounts.length === 0 ? (
                      <span className="px-2 py-0.5 rounded-sm text-2xs bg-status-warning-bg text-status-warning border border-status-warning/30">
                        Connect account first
                      </span>
                    ) : (
                      <span
                        className={`px-2 py-0.5 rounded-sm text-2xs ${
                          config.channels.includes("advertising")
                            ? "bg-accent-subtle text-accent"
                            : "bg-bg-hover text-muted"
                        }`}
                      >
                        Custom budget
                      </span>
                    )}
                  </div>
                  <p
                    className={`text-sm mt-0.5 ${adAccounts.length === 0 ? "text-muted" : "text-muted"}`}
                  >
                    Run paid ad campaigns
                  </p>
                </div>
                <div
                  className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    config.channels.includes("advertising")
                      ? "border-accent bg-accent"
                      : "border-border-strong"
                  }`}
                >
                  {config.channels.includes("advertising") && (
                    <Check className="h-3 w-3 text-accent-foreground" />
                  )}
                </div>
              </Button>

              <div className="flex items-center justify-between pt-4 border-t border-border">
                <p className="text-sm text-muted">
                  {config.channels.length === 0
                    ? "Select at least one channel"
                    : `${config.channels.length} channel(s) selected`}
                </p>
                <Button
                  onClick={() => {
                    const first = config.channels[0];
                    if (!first) return;
                    setActiveTab(first);
                    setStep("configure");
                  }}
                  disabled={config.channels.length === 0}
                  className={`h-9 px-4 ${
                    config.channels.length === 0
                      ? "bg-bg-muted text-muted"
                      : "bg-accent hover:bg-accent-hover text-accent-foreground"
                  }`}
                >
                  Continue
                  <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
              </div>
            </div>
          )}

          {/* Step: Configure */}
          {step === "configure" && (
            <div className="space-y-4">
              {/* Tab buttons */}
              <div className="flex gap-2">
                {config.channels.map((channel) => (
                  <Button
                    variant="ghost"
                    type="button"
                    key={channel}
                    onClick={() => setActiveTab(channel)}
                    className={`px-3 py-1.5 rounded-sm text-sm font-medium transition-all ${
                      activeTab === channel
                        ? "bg-bg-hover text-txt"
                        : "text-muted hover:text-txt"
                    }`}
                  >
                    {channel === "social"
                      ? "Social Media"
                      : channel === "seo"
                        ? "SEO"
                        : "Advertising"}
                  </Button>
                ))}
              </div>

              {/* Social Config */}
              {activeTab === "social" && config.channels.includes("social") && (
                <div className="space-y-4">
                  <div>
                    <Label className="text-txt text-sm mb-2 block">
                      Select Platforms
                    </Label>
                    <div className="grid grid-cols-3 gap-2">
                      {SOCIAL_PLATFORMS.map((platform) => (
                        <Button
                          variant="ghost"
                          type="button"
                          key={platform.id}
                          onClick={() => toggleSocialPlatform(platform.id)}
                          className={`flex items-center gap-2 p-3 rounded-sm transition-all ${
                            config.social?.platforms?.includes(platform.id)
                              ? "bg-accent-subtle border border-accent/50"
                              : "bg-bg-elevated border border-border hover:border-border-strong"
                          }`}
                        >
                          <div
                            className={`w-4 h-4 rounded-sm border flex items-center justify-center ${
                              config.social?.platforms?.includes(platform.id)
                                ? "bg-accent border-accent"
                                : "border-border-strong"
                            }`}
                          >
                            {config.social?.platforms?.includes(
                              platform.id,
                            ) && (
                              <Check className="h-3 w-3 text-accent-foreground" />
                            )}
                          </div>
                          <platform.Icon
                            className="h-4 w-4 text-txt"
                            strokeWidth={2}
                          />
                          <span className="text-sm text-txt">
                            {platform.name}
                          </span>
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <Label className="text-txt text-sm">
                      Custom Message (optional)
                    </Label>
                    <Textarea
                      placeholder="Leave blank to auto-generate..."
                      value={config.social?.customMessage || ""}
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          social: {
                            ...prev.social,
                            platforms: prev.social?.platforms || [],
                            customMessage: e.target.value,
                          },
                        }))
                      }
                      className="mt-1.5 bg-bg-elevated border-border text-txt placeholder:text-muted rounded-sm"
                      rows={3}
                    />
                  </div>
                </div>
              )}

              {/* SEO Config */}
              {activeTab === "seo" && config.channels.includes("seo") && (
                <div className="space-y-3">
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() =>
                      setConfig((prev) => ({
                        ...prev,
                        seo: {
                          generateMeta: !(prev.seo?.generateMeta ?? true),
                          generateSchema: prev.seo?.generateSchema ?? true,
                          submitToIndexNow: prev.seo?.submitToIndexNow ?? true,
                        },
                      }))
                    }
                    className={`w-full flex items-center gap-4 p-4 rounded-sm border transition-all text-left ${
                      (config.seo?.generateMeta ?? true)
                        ? "border-status-success/50 bg-status-success-bg"
                        : "border-border bg-bg-elevated hover:bg-bg-hover hover:border-border-strong"
                    }`}
                  >
                    <FileText
                      className={`h-5 w-5 ${(config.seo?.generateMeta ?? true) ? "text-status-success" : "text-muted"}`}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-txt">
                        Generate Meta Tags
                      </p>
                      <p className="text-xs text-muted mt-0.5">
                        AI-generated title, description, and keywords
                      </p>
                    </div>
                    <div
                      className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                        (config.seo?.generateMeta ?? true)
                          ? "border-status-success bg-status-success"
                          : "border-border-strong"
                      }`}
                    >
                      {(config.seo?.generateMeta ?? true) && (
                        <Check className="h-3 w-3 text-[var(--brand-white)]" />
                      )}
                    </div>
                  </Button>

                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() =>
                      setConfig((prev) => ({
                        ...prev,
                        seo: {
                          generateMeta: prev.seo?.generateMeta ?? true,
                          generateSchema: !(prev.seo?.generateSchema ?? true),
                          submitToIndexNow: prev.seo?.submitToIndexNow ?? true,
                        },
                      }))
                    }
                    className={`w-full flex items-center gap-4 p-4 rounded-sm border transition-all text-left ${
                      (config.seo?.generateSchema ?? true)
                        ? "border-status-success/50 bg-status-success-bg"
                        : "border-border bg-bg-elevated hover:bg-bg-hover hover:border-border-strong"
                    }`}
                  >
                    <Braces
                      className={`h-5 w-5 ${(config.seo?.generateSchema ?? true) ? "text-status-success" : "text-muted"}`}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-txt">
                        Generate Schema.org Data
                      </p>
                      <p className="text-xs text-muted mt-0.5">
                        Structured data for rich search results
                      </p>
                    </div>
                    <div
                      className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                        (config.seo?.generateSchema ?? true)
                          ? "border-status-success bg-status-success"
                          : "border-border-strong"
                      }`}
                    >
                      {(config.seo?.generateSchema ?? true) && (
                        <Check className="h-3 w-3 text-[var(--brand-white)]" />
                      )}
                    </div>
                  </Button>

                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() =>
                      setConfig((prev) => ({
                        ...prev,
                        seo: {
                          generateMeta: prev.seo?.generateMeta ?? true,
                          generateSchema: prev.seo?.generateSchema ?? true,
                          submitToIndexNow: !(
                            prev.seo?.submitToIndexNow ?? true
                          ),
                        },
                      }))
                    }
                    className={`w-full flex items-center gap-4 p-4 rounded-sm border transition-all text-left ${
                      (config.seo?.submitToIndexNow ?? true)
                        ? "border-status-success/50 bg-status-success-bg"
                        : "border-border bg-bg-elevated hover:bg-bg-hover hover:border-border-strong"
                    }`}
                  >
                    <Send
                      className={`h-5 w-5 ${(config.seo?.submitToIndexNow ?? true) ? "text-status-success" : "text-muted"}`}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-txt">
                        Submit to IndexNow
                      </p>
                      <p className="text-xs text-muted mt-0.5">
                        Notify search engines of your new content
                      </p>
                    </div>
                    <div
                      className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                        (config.seo?.submitToIndexNow ?? true)
                          ? "border-status-success bg-status-success"
                          : "border-border-strong"
                      }`}
                    >
                      {(config.seo?.submitToIndexNow ?? true) && (
                        <Check className="h-3 w-3 text-[var(--brand-white)]" />
                      )}
                    </div>
                  </Button>
                </div>
              )}

              {/* Advertising Config */}
              {activeTab === "advertising" &&
                config.channels.includes("advertising") && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label className="text-txt text-sm">Ad Account</Label>
                      <Select
                        value={config.advertising?.adAccountId}
                        onValueChange={(value) => {
                          const account = adAccounts.find(
                            (a) => a.id === value,
                          );
                          setConfig((prev) => ({
                            ...prev,
                            advertising: {
                              ...prev.advertising,
                              adAccountId: value,
                              platform: account?.platform || "meta",
                              budget: prev.advertising?.budget || 10,
                              budgetType:
                                prev.advertising?.budgetType || "daily",
                              objective:
                                prev.advertising?.objective || "traffic",
                              bidStrategy:
                                prev.advertising?.bidStrategy || "cpm",
                              optimizationGoal:
                                prev.advertising?.optimizationGoal || "reach",
                            },
                          }));
                        }}
                      >
                        <SelectTrigger className="mt-1.5 bg-bg-elevated border-border text-txt rounded-sm">
                          <SelectValue placeholder="Select account" />
                        </SelectTrigger>
                        <SelectContent className="bg-card border-border">
                          {adAccounts.map((account) => (
                            <SelectItem
                              key={account.id}
                              value={account.id}
                              className="text-txt"
                            >
                              {account.accountName} ({account.platform})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div>
                      <Label className="text-txt text-sm">Objective</Label>
                      <Select
                        value={config.advertising?.objective}
                        onValueChange={(value) =>
                          setConfig((prev) => ({
                            ...prev,
                            advertising: {
                              ...getAdvertisingConfig(prev),
                              objective: value,
                            },
                          }))
                        }
                      >
                        <SelectTrigger className="mt-1.5 bg-bg-elevated border-border text-txt rounded-sm">
                          <SelectValue placeholder="Select objective" />
                        </SelectTrigger>
                        <SelectContent className="bg-card border-border">
                          {AD_OBJECTIVES.map((obj) => (
                            <SelectItem
                              key={obj.id}
                              value={obj.id}
                              className="text-txt"
                            >
                              {obj.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div>
                      <Label className="text-txt text-sm">Bid Strategy</Label>
                      <Select
                        value={config.advertising?.bidStrategy || "cpm"}
                        onValueChange={(value: CampaignBidStrategy) =>
                          setConfig((prev) => ({
                            ...prev,
                            advertising: {
                              ...getAdvertisingConfig(prev),
                              bidStrategy: value,
                            },
                          }))
                        }
                      >
                        <SelectTrigger className="mt-1.5 bg-bg-elevated border-border text-txt rounded-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-card border-border">
                          {BID_STRATEGIES.map((strategy) => (
                            <SelectItem
                              key={strategy.id}
                              value={strategy.id}
                              className="text-txt"
                            >
                              {strategy.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div>
                      <Label className="text-txt text-sm">
                        Optimization Goal
                      </Label>
                      <Select
                        value={config.advertising?.optimizationGoal || "reach"}
                        onValueChange={(value: CampaignOptimizationGoal) =>
                          setConfig((prev) => ({
                            ...prev,
                            advertising: {
                              ...getAdvertisingConfig(prev),
                              optimizationGoal: value,
                            },
                          }))
                        }
                      >
                        <SelectTrigger className="mt-1.5 bg-bg-elevated border-border text-txt rounded-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-card border-border">
                          {OPTIMIZATION_GOALS.map((goal) => (
                            <SelectItem
                              key={goal.id}
                              value={goal.id}
                              className="text-txt"
                            >
                              {goal.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div>
                      <Label className="text-txt text-sm">Budget ($)</Label>
                      <Input
                        type="number"
                        min={1}
                        max={10000}
                        value={config.advertising?.budget || 10}
                        onChange={(e) =>
                          setConfig((prev) => ({
                            ...prev,
                            advertising: {
                              ...getAdvertisingConfig(prev),
                              budget: parseFloat(e.target.value) || 10,
                            },
                          }))
                        }
                        className="mt-1.5 bg-bg-elevated border-border text-txt rounded-sm"
                      />
                    </div>

                    <div>
                      <Label className="text-txt text-sm">Budget Type</Label>
                      <Select
                        value={config.advertising?.budgetType || "daily"}
                        onValueChange={(value: "daily" | "lifetime") =>
                          setConfig((prev) => ({
                            ...prev,
                            advertising: {
                              ...getAdvertisingConfig(prev),
                              budgetType: value,
                            },
                          }))
                        }
                      >
                        <SelectTrigger className="mt-1.5 bg-bg-elevated border-border text-txt rounded-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-card border-border">
                          <SelectItem value="daily" className="text-txt">
                            Daily Budget
                          </SelectItem>
                          <SelectItem value="lifetime" className="text-txt">
                            Total Budget
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="col-span-2">
                      <Label className="text-txt text-sm">
                        Audience Segment
                      </Label>
                      <Select
                        value={config.advertising?.audienceSegmentId || "none"}
                        onValueChange={(value) =>
                          setConfig((prev) => ({
                            ...prev,
                            advertising: {
                              ...getAdvertisingConfig(prev),
                              audienceSegmentId:
                                value === "none" ? undefined : value,
                            },
                          }))
                        }
                      >
                        <SelectTrigger className="mt-1.5 bg-bg-elevated border-border text-txt rounded-sm">
                          <SelectValue placeholder="Optional saved segment" />
                        </SelectTrigger>
                        <SelectContent className="bg-card border-border">
                          <SelectItem value="none" className="text-txt">
                            No saved segment
                          </SelectItem>
                          {audienceSegments.map((segment) => (
                            <SelectItem
                              key={segment.id}
                              value={segment.id}
                              className="text-txt"
                            >
                              {segment.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}

              <div className="flex items-center justify-between pt-4 border-t border-border">
                <Button
                  variant="outline"
                  onClick={() => setStep("channels")}
                  className="h-9 px-4 border-border-strong text-txt hover:bg-bg-hover"
                >
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Back
                </Button>
                <Button
                  onClick={() => setStep("review")}
                  className="h-9 px-4 bg-accent hover:bg-accent-hover text-accent-foreground"
                >
                  Review & Launch
                  <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
              </div>
            </div>
          )}

          {/* Step: Review */}
          {step === "review" && (
            <div className="space-y-4">
              <div className="p-4 rounded-sm bg-bg-elevated border border-border space-y-4">
                <h3 className="text-sm font-medium text-txt">
                  Promotion Summary
                </h3>

                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted">App:</span>
                    <span className="text-txt font-medium">{app.name}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted">URL:</span>
                    <span className="text-accent font-medium">
                      {app.app_url}
                    </span>
                  </div>
                </div>

                <div className="border-t border-border pt-4 space-y-2">
                  {config.channels.includes("social") && (
                    <div className="flex items-center gap-2 text-sm">
                      <CheckCircle className="h-4 w-4 text-status-success" />
                      <span className="text-txt">
                        Social:{" "}
                        {config.social?.platforms?.join(", ") ||
                          "No platforms selected"}
                      </span>
                    </div>
                  )}
                  {config.channels.includes("seo") && (
                    <div className="flex items-center gap-2 text-sm">
                      <CheckCircle className="h-4 w-4 text-status-success" />
                      <span className="text-txt">SEO Optimization</span>
                    </div>
                  )}
                  {config.channels.includes("advertising") && (
                    <div className="flex items-center gap-2 text-sm">
                      <CheckCircle className="h-4 w-4 text-status-success" />
                      <span className="text-txt">
                        Ad Campaign: ${config.advertising?.budget}{" "}
                        {config.advertising?.budgetType},{" "}
                        {(
                          config.advertising?.bidStrategy || "cpm"
                        ).toUpperCase()}{" "}
                        for {config.advertising?.optimizationGoal || "reach"}
                      </span>
                    </div>
                  )}
                </div>

                <div className="border-t border-border pt-4">
                  <p className="text-xs text-muted">
                    Credits are charged based on the work actually performed.
                    The exact amount used is shown after the promotion launches.
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-border">
                <Button
                  variant="outline"
                  onClick={() => setStep("configure")}
                  className="h-9 px-4 border-border-strong text-txt hover:bg-bg-hover"
                >
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Back
                </Button>
                <Button
                  onClick={handlePromote}
                  disabled={isLoading}
                  className={`h-9 px-4 text-accent-foreground ${
                    isLoading
                      ? "bg-bg-muted text-muted"
                      : "bg-accent hover:bg-accent-hover"
                  }`}
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Launching...
                    </>
                  ) : (
                    "Launch Promotion"
                  )}
                </Button>
              </div>
            </div>
          )}

          {/* Step: Result */}
          {step === "result" && result && (
            <div className="space-y-4">
              <div className="text-center py-6">
                {result.success ? (
                  <CheckCircle className="h-14 w-14 text-status-success mx-auto mb-4" />
                ) : (
                  <AlertCircle className="h-14 w-14 text-status-warning mx-auto mb-4" />
                )}
                <h3 className="text-xl font-medium text-txt">
                  {result.success ? "Promotion Launched!" : "Partial Success"}
                </h3>
                <p className="text-sm text-muted mt-2">
                  Used ${result.totalCreditsUsed.toFixed(2)} in credits
                </p>
              </div>

              <div className="space-y-2">
                {Object.entries(result.channels).map(
                  ([channel, status]) =>
                    status && (
                      <div
                        key={channel}
                        className={`p-4 rounded-sm flex items-center justify-between ${
                          status.success
                            ? "bg-status-success-bg border border-status-success/30"
                            : "bg-status-danger-bg border border-status-danger/30"
                        }`}
                      >
                        <span className="text-sm font-medium text-txt capitalize">
                          {channel}
                        </span>
                        <span
                          className={`text-xs font-medium px-2 py-1 rounded-sm ${
                            status.success
                              ? "bg-status-success-bg text-status-success"
                              : "bg-status-danger-bg text-status-danger"
                          }`}
                        >
                          {status.success ? "Success" : "Failed"}
                        </span>
                      </div>
                    ),
                )}
              </div>

              {Object.entries(result.channels).some(
                ([, status]) => status && !status.success && status.error,
              ) && (
                <div className="p-3 rounded-sm bg-status-danger-bg border border-status-danger/20">
                  {Object.entries(result.channels).map(
                    ([channel, status]) =>
                      status &&
                      !status.success &&
                      status.error && (
                        <p key={channel} className="text-sm text-status-danger">
                          {channel}: {status.error}
                        </p>
                      ),
                  )}
                </div>
              )}

              <div className="pt-4 border-t border-border">
                <Button
                  onClick={handleClose}
                  className="w-full h-9 bg-accent hover:bg-accent-hover text-accent-foreground"
                >
                  Done
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
