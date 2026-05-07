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
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Braces,
  Check,
  CheckCircle,
  FileText,
  Loader2,
  Megaphone,
  Search,
  Send,
  Share2,
} from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

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
    duration?: number;
  };
}

const SOCIAL_PLATFORMS = [
  { id: "twitter", name: "Twitter/X", icon: "𝕏" },
  { id: "bluesky", name: "Bluesky", icon: "🦋" },
  { id: "linkedin", name: "LinkedIn", icon: "in" },
  { id: "facebook", name: "Facebook", icon: "f" },
  { id: "discord", name: "Discord", icon: "🎮" },
  { id: "telegram", name: "Telegram", icon: "✈️" },
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

export function PromoteAppDialog({
  open,
  onOpenChange,
  app,
  adAccounts = [],
}: PromoteAppDialogProps) {
  const [step, setStep] = useState<"channels" | "configure" | "review" | "result">("channels");
  const [activeTab, setActiveTab] = useState<PromotionChannel>("social");
  const [isLoading, setIsLoading] = useState(false);
  const [config, setConfig] = useState<PromotionConfig>({ channels: [] });
  const [result, setResult] = useState<{
    success: boolean;
    channels: Record<string, { success: boolean; error?: string }>;
    totalCreditsUsed: number;
  } | null>(null);

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
    const response = await fetch(`/api/v1/apps/${app.id}/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    const data = await response.json();
    setIsLoading(false);

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
  }, [app.id, config]);

  const handleClose = () => {
    setStep("channels");
    setConfig({ channels: [] });
    setResult(null);
    onOpenChange(false);
  };

  const estimatedCost = () => {
    let cost = 0;
    if (config.channels.includes("social")) {
      cost += (config.social?.platforms?.length || 0) * 0.01 + 0.02;
    }
    if (config.channels.includes("seo")) {
      cost += 0.03;
    }
    if (config.channels.includes("advertising") && config.advertising) {
      cost += 0.5 + config.advertising.budget * 1.15;
    }
    return cost.toFixed(2);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl bg-neutral-900 border-white/10 p-0 overflow-hidden">
        <DialogHeader className="p-6 pb-0">
          <DialogTitle className="text-white text-lg font-medium">Promote {app.name}</DialogTitle>
          <p className="text-sm text-neutral-500 mt-1">
            Launch your app across multiple channels to reach more users
          </p>
        </DialogHeader>

        <div className="p-6 pt-4">
          {/* Step: Channels */}
          {step === "channels" && (
            <div className="space-y-3">
              {/* Social */}
              <button
                onClick={() => toggleChannel("social")}
                className={`w-full flex items-center gap-4 p-4 rounded-xl border transition-all text-left group ${
                  config.channels.includes("social")
                    ? "border-blue-500/50 bg-blue-500/10"
                    : "border-white/10 bg-white/5 hover:bg-white/[0.07] hover:border-white/20"
                }`}
              >
                <Share2
                  className={`h-6 w-6 ${config.channels.includes("social") ? "text-blue-400" : "text-neutral-400"}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-white">Social Media</span>
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] ${
                        config.channels.includes("social")
                          ? "bg-blue-500/20 text-blue-300"
                          : "bg-white/10 text-neutral-400"
                      }`}
                    >
                      ~$0.02/post
                    </span>
                  </div>
                  <p className="text-sm text-white/50 mt-0.5">
                    Post to Twitter, LinkedIn, Discord...
                  </p>
                </div>
                <div
                  className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    config.channels.includes("social")
                      ? "border-blue-500 bg-blue-600"
                      : "border-white/30"
                  }`}
                >
                  {config.channels.includes("social") && <Check className="h-3 w-3 text-white" />}
                </div>
              </button>

              {/* SEO */}
              <button
                onClick={() => toggleChannel("seo")}
                className={`w-full flex items-center gap-4 p-4 rounded-xl border transition-all text-left group ${
                  config.channels.includes("seo")
                    ? "border-green-500/50 bg-green-500/10"
                    : "border-white/10 bg-white/5 hover:bg-white/[0.07] hover:border-white/20"
                }`}
              >
                <Search
                  className={`h-6 w-6 ${config.channels.includes("seo") ? "text-green-400" : "text-neutral-400"}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-white">SEO</span>
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] ${
                        config.channels.includes("seo")
                          ? "bg-green-500/20 text-green-300"
                          : "bg-white/10 text-neutral-400"
                      }`}
                    >
                      ~$0.03
                    </span>
                  </div>
                  <p className="text-sm text-white/50 mt-0.5">Optimize for search engines</p>
                </div>
                <div
                  className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    config.channels.includes("seo")
                      ? "border-green-500 bg-green-600"
                      : "border-white/30"
                  }`}
                >
                  {config.channels.includes("seo") && <Check className="h-3 w-3 text-white" />}
                </div>
              </button>

              {/* Advertising */}
              <button
                onClick={() => adAccounts.length > 0 && toggleChannel("advertising")}
                className={`w-full flex items-center gap-4 p-4 rounded-xl border transition-all text-left group ${
                  config.channels.includes("advertising")
                    ? "border-purple-500/50 bg-purple-500/10"
                    : adAccounts.length === 0
                      ? "border-white/10 bg-white/5 opacity-60 cursor-not-allowed"
                      : "border-white/10 bg-white/5 hover:bg-white/[0.07] hover:border-white/20"
                }`}
              >
                <Megaphone
                  className={`h-6 w-6 ${
                    config.channels.includes("advertising")
                      ? "text-purple-400"
                      : adAccounts.length === 0
                        ? "text-neutral-600"
                        : "text-neutral-400"
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`font-medium ${adAccounts.length === 0 ? "text-neutral-500" : "text-white"}`}
                    >
                      Advertising
                    </span>
                    {adAccounts.length === 0 ? (
                      <span className="px-2 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-400 border border-amber-500/30">
                        Connect account first
                      </span>
                    ) : (
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] ${
                          config.channels.includes("advertising")
                            ? "bg-purple-500/20 text-purple-300"
                            : "bg-white/10 text-neutral-400"
                        }`}
                      >
                        Custom budget
                      </span>
                    )}
                  </div>
                  <p
                    className={`text-sm mt-0.5 ${adAccounts.length === 0 ? "text-neutral-600" : "text-white/50"}`}
                  >
                    Run paid ad campaigns
                  </p>
                </div>
                <div
                  className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    config.channels.includes("advertising")
                      ? "border-purple-500 bg-purple-600"
                      : "border-white/30"
                  }`}
                >
                  {config.channels.includes("advertising") && (
                    <Check className="h-3 w-3 text-white" />
                  )}
                </div>
              </button>

              <div className="flex items-center justify-between pt-4 border-t border-white/10">
                <p className="text-sm text-neutral-500">
                  {config.channels.length === 0
                    ? "Select at least one channel"
                    : `${config.channels.length} channel(s) selected`}
                </p>
                <Button
                  onClick={() => {
                    setActiveTab(config.channels[0]);
                    setStep("configure");
                  }}
                  disabled={config.channels.length === 0}
                  className={`h-9 px-4 ${
                    config.channels.length === 0
                      ? "bg-neutral-700 text-neutral-400"
                      : "bg-[#FF5800] hover:bg-[#FF5800]/80 text-white"
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
                  <button
                    key={channel}
                    onClick={() => setActiveTab(channel)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                      activeTab === channel
                        ? "bg-white/10 text-white"
                        : "text-neutral-500 hover:text-white"
                    }`}
                  >
                    {channel === "social"
                      ? "Social Media"
                      : channel === "seo"
                        ? "SEO"
                        : "Advertising"}
                  </button>
                ))}
              </div>

              {/* Social Config */}
              {activeTab === "social" && config.channels.includes("social") && (
                <div className="space-y-4">
                  <div>
                    <Label className="text-white text-sm mb-2 block">Select Platforms</Label>
                    <div className="grid grid-cols-3 gap-2">
                      {SOCIAL_PLATFORMS.map((platform) => (
                        <button
                          key={platform.id}
                          onClick={() => toggleSocialPlatform(platform.id)}
                          className={`flex items-center gap-2 p-3 rounded-lg transition-all ${
                            config.social?.platforms?.includes(platform.id)
                              ? "bg-blue-500/10 border border-blue-500/50"
                              : "bg-black/30 border border-white/5 hover:border-white/20"
                          }`}
                        >
                          <div
                            className={`w-4 h-4 rounded border flex items-center justify-center ${
                              config.social?.platforms?.includes(platform.id)
                                ? "bg-blue-500 border-blue-500"
                                : "border-white/20"
                            }`}
                          >
                            {config.social?.platforms?.includes(platform.id) && (
                              <Check className="h-3 w-3 text-white" />
                            )}
                          </div>
                          <span className="text-base">{platform.icon}</span>
                          <span className="text-sm text-white">{platform.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <Label className="text-white text-sm">Custom Message (optional)</Label>
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
                      className="mt-1.5 bg-black/30 border-white/10 text-white placeholder:text-neutral-600 rounded-lg"
                      rows={3}
                    />
                  </div>
                </div>
              )}

              {/* SEO Config */}
              {activeTab === "seo" && config.channels.includes("seo") && (
                <div className="space-y-3">
                  <button
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
                    className={`w-full flex items-center gap-4 p-4 rounded-xl border transition-all text-left ${
                      (config.seo?.generateMeta ?? true)
                        ? "border-green-500/50 bg-green-500/10"
                        : "border-white/10 bg-white/5 hover:bg-white/[0.07] hover:border-white/20"
                    }`}
                  >
                    <FileText
                      className={`h-5 w-5 ${(config.seo?.generateMeta ?? true) ? "text-green-400" : "text-neutral-400"}`}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white">Generate Meta Tags</p>
                      <p className="text-xs text-white/50 mt-0.5">
                        AI-generated title, description, and keywords
                      </p>
                    </div>
                    <div
                      className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                        (config.seo?.generateMeta ?? true)
                          ? "border-green-500 bg-green-600"
                          : "border-white/30"
                      }`}
                    >
                      {(config.seo?.generateMeta ?? true) && (
                        <Check className="h-3 w-3 text-white" />
                      )}
                    </div>
                  </button>

                  <button
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
                    className={`w-full flex items-center gap-4 p-4 rounded-xl border transition-all text-left ${
                      (config.seo?.generateSchema ?? true)
                        ? "border-green-500/50 bg-green-500/10"
                        : "border-white/10 bg-white/5 hover:bg-white/[0.07] hover:border-white/20"
                    }`}
                  >
                    <Braces
                      className={`h-5 w-5 ${(config.seo?.generateSchema ?? true) ? "text-green-400" : "text-neutral-400"}`}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white">Generate Schema.org Data</p>
                      <p className="text-xs text-white/50 mt-0.5">
                        Structured data for rich search results
                      </p>
                    </div>
                    <div
                      className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                        (config.seo?.generateSchema ?? true)
                          ? "border-green-500 bg-green-600"
                          : "border-white/30"
                      }`}
                    >
                      {(config.seo?.generateSchema ?? true) && (
                        <Check className="h-3 w-3 text-white" />
                      )}
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setConfig((prev) => ({
                        ...prev,
                        seo: {
                          generateMeta: prev.seo?.generateMeta ?? true,
                          generateSchema: prev.seo?.generateSchema ?? true,
                          submitToIndexNow: !(prev.seo?.submitToIndexNow ?? true),
                        },
                      }))
                    }
                    className={`w-full flex items-center gap-4 p-4 rounded-xl border transition-all text-left ${
                      (config.seo?.submitToIndexNow ?? true)
                        ? "border-green-500/50 bg-green-500/10"
                        : "border-white/10 bg-white/5 hover:bg-white/[0.07] hover:border-white/20"
                    }`}
                  >
                    <Send
                      className={`h-5 w-5 ${(config.seo?.submitToIndexNow ?? true) ? "text-green-400" : "text-neutral-400"}`}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white">Submit to IndexNow</p>
                      <p className="text-xs text-white/50 mt-0.5">
                        Notify search engines of your new content
                      </p>
                    </div>
                    <div
                      className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                        (config.seo?.submitToIndexNow ?? true)
                          ? "border-green-500 bg-green-600"
                          : "border-white/30"
                      }`}
                    >
                      {(config.seo?.submitToIndexNow ?? true) && (
                        <Check className="h-3 w-3 text-white" />
                      )}
                    </div>
                  </button>
                </div>
              )}

              {/* Advertising Config */}
              {activeTab === "advertising" && config.channels.includes("advertising") && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-white text-sm">Ad Account</Label>
                    <Select
                      value={config.advertising?.adAccountId}
                      onValueChange={(value) => {
                        const account = adAccounts.find((a) => a.id === value);
                        setConfig((prev) => ({
                          ...prev,
                          advertising: {
                            ...prev.advertising,
                            adAccountId: value,
                            platform: account?.platform || "meta",
                            budget: prev.advertising?.budget || 10,
                            budgetType: prev.advertising?.budgetType || "daily",
                            objective: prev.advertising?.objective || "traffic",
                          },
                        }));
                      }}
                    >
                      <SelectTrigger className="mt-1.5 bg-black/30 border-white/10 text-white rounded-lg">
                        <SelectValue placeholder="Select account" />
                      </SelectTrigger>
                      <SelectContent className="bg-neutral-800 border-white/10">
                        {adAccounts.map((account) => (
                          <SelectItem key={account.id} value={account.id} className="text-white">
                            {account.accountName} ({account.platform})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label className="text-white text-sm">Objective</Label>
                    <Select
                      value={config.advertising?.objective}
                      onValueChange={(value) =>
                        setConfig((prev) => ({
                          ...prev,
                          advertising: {
                            ...prev.advertising!,
                            objective: value,
                          },
                        }))
                      }
                    >
                      <SelectTrigger className="mt-1.5 bg-black/30 border-white/10 text-white rounded-lg">
                        <SelectValue placeholder="Select objective" />
                      </SelectTrigger>
                      <SelectContent className="bg-neutral-800 border-white/10">
                        {AD_OBJECTIVES.map((obj) => (
                          <SelectItem key={obj.id} value={obj.id} className="text-white">
                            {obj.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label className="text-white text-sm">Budget ($)</Label>
                    <Input
                      type="number"
                      min={1}
                      max={10000}
                      value={config.advertising?.budget || 10}
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          advertising: {
                            ...prev.advertising!,
                            budget: parseFloat(e.target.value) || 10,
                          },
                        }))
                      }
                      className="mt-1.5 bg-black/30 border-white/10 text-white rounded-lg"
                    />
                  </div>

                  <div>
                    <Label className="text-white text-sm">Budget Type</Label>
                    <Select
                      value={config.advertising?.budgetType || "daily"}
                      onValueChange={(value: "daily" | "lifetime") =>
                        setConfig((prev) => ({
                          ...prev,
                          advertising: {
                            ...prev.advertising!,
                            budgetType: value,
                          },
                        }))
                      }
                    >
                      <SelectTrigger className="mt-1.5 bg-black/30 border-white/10 text-white rounded-lg">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-neutral-800 border-white/10">
                        <SelectItem value="daily" className="text-white">
                          Daily Budget
                        </SelectItem>
                        <SelectItem value="lifetime" className="text-white">
                          Total Budget
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between pt-4 border-t border-white/5">
                <Button
                  variant="outline"
                  onClick={() => setStep("channels")}
                  className="h-9 px-4 border-white/20 text-white hover:bg-white/10"
                >
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Back
                </Button>
                <Button
                  onClick={() => setStep("review")}
                  className="h-9 px-4 bg-[#FF5800] hover:bg-[#FF5800]/80 text-white"
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
              <div className="p-4 rounded-lg bg-black/30 border border-white/5 space-y-4">
                <h3 className="text-sm font-medium text-white">Promotion Summary</h3>

                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-neutral-400">App:</span>
                    <span className="text-white font-medium">{app.name}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-neutral-400">URL:</span>
                    <span className="text-[#FF5800] font-medium">{app.app_url}</span>
                  </div>
                </div>

                <div className="border-t border-white/5 pt-4 space-y-2">
                  {config.channels.includes("social") && (
                    <div className="flex items-center gap-2 text-sm">
                      <CheckCircle className="h-4 w-4 text-green-400" />
                      <span className="text-white">
                        Social: {config.social?.platforms?.join(", ") || "No platforms selected"}
                      </span>
                    </div>
                  )}
                  {config.channels.includes("seo") && (
                    <div className="flex items-center gap-2 text-sm">
                      <CheckCircle className="h-4 w-4 text-green-400" />
                      <span className="text-white">SEO Optimization</span>
                    </div>
                  )}
                  {config.channels.includes("advertising") && (
                    <div className="flex items-center gap-2 text-sm">
                      <CheckCircle className="h-4 w-4 text-green-400" />
                      <span className="text-white">
                        Ad Campaign: ${config.advertising?.budget} {config.advertising?.budgetType}
                      </span>
                    </div>
                  )}
                </div>

                <div className="border-t border-white/5 pt-4 flex justify-between">
                  <span className="text-sm font-medium text-white">Estimated Cost:</span>
                  <span className="text-sm font-medium text-white">${estimatedCost()}</span>
                </div>
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-white/5">
                <Button
                  variant="outline"
                  onClick={() => setStep("configure")}
                  className="h-9 px-4 border-white/20 text-white hover:bg-white/10"
                >
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Back
                </Button>
                <Button
                  onClick={handlePromote}
                  disabled={isLoading}
                  className={`h-9 px-4 text-white ${
                    isLoading
                      ? "bg-neutral-700 text-neutral-400"
                      : "bg-[#FF5800] hover:bg-[#FF5800]/80"
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
                  <CheckCircle className="h-14 w-14 text-green-400 mx-auto mb-4" />
                ) : (
                  <AlertCircle className="h-14 w-14 text-amber-400 mx-auto mb-4" />
                )}
                <h3 className="text-xl font-medium text-white">
                  {result.success ? "Promotion Launched!" : "Partial Success"}
                </h3>
                <p className="text-sm text-neutral-500 mt-2">
                  Used ${result.totalCreditsUsed.toFixed(2)} in credits
                </p>
              </div>

              <div className="space-y-2">
                {Object.entries(result.channels).map(
                  ([channel, status]) =>
                    status && (
                      <div
                        key={channel}
                        className={`p-4 rounded-lg flex items-center justify-between ${
                          status.success
                            ? "bg-green-500/10 border border-green-500/30"
                            : "bg-red-500/10 border border-red-500/30"
                        }`}
                      >
                        <span className="text-sm font-medium text-white capitalize">{channel}</span>
                        <span
                          className={`text-xs font-medium px-2 py-1 rounded ${
                            status.success
                              ? "bg-green-500/20 text-green-400"
                              : "bg-red-500/20 text-red-400"
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
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                  {Object.entries(result.channels).map(
                    ([channel, status]) =>
                      status &&
                      !status.success &&
                      status.error && (
                        <p key={channel} className="text-sm text-red-400">
                          {channel}: {status.error}
                        </p>
                      ),
                  )}
                </div>
              )}

              <div className="pt-4 border-t border-white/5">
                <Button
                  onClick={handleClose}
                  className="w-full h-9 bg-[#FF5800] hover:bg-[#FF5800]/80 text-white"
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
