"use client";

import { Badge, Button } from "@elizaos/cloud-ui";
import {
  ExternalLink,
  Image as ImageIcon,
  Loader2,
  Megaphone,
  Plus,
  Search,
  Share2,
  Sparkles,
  TrendingUp,
  Video,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AppDto } from "@/types/cloud-api";
import { PromoteAppDialog } from "@elizaos/cloud-ui/components/promotion/promote-app-dialog";

interface AppPromoteProps {
  app: AppDto;
}

interface PromotionSuggestions {
  recommendedChannels: string[];
  estimatedBudget: { min: number; max: number };
  suggestedPlatforms: string[];
  tips: string[];
}

interface AdAccount {
  id: string;
  platform: string;
  accountName: string;
}

export function AppPromote({ app }: AppPromoteProps) {
  const [showPromoteDialog, setShowPromoteDialog] = useState(false);
  const [suggestions, setSuggestions] = useState<PromotionSuggestions | null>(null);
  const [adAccounts, setAdAccounts] = useState<AdAccount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isGeneratingAssets, setIsGeneratingAssets] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);

      const suggestionsRes = await fetch(`/api/v1/apps/${app.id}/promote`);
      if (suggestionsRes.ok) {
        const data = await suggestionsRes.json();
        setSuggestions(data);
      }

      const accountsRes = await fetch("/api/v1/advertising/accounts");
      if (accountsRes.ok) {
        const data = await accountsRes.json();
        setAdAccounts(data.accounts || []);
      }

      setIsLoading(false);
    };

    fetchData();
  }, [app.id]);

  const handleGenerateAssets = async () => {
    setIsGeneratingAssets(true);

    const response = await fetch(`/api/v1/apps/${app.id}/promote/assets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        includeCopy: true,
        includeAdBanners: true,
      }),
    });

    if (response.ok) {
      window.location.reload();
    }

    setIsGeneratingAssets(false);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-neutral-400" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-white flex items-center gap-2">
            <Megaphone className="h-4 w-4 text-[#FF5800]" />
            Promote {app.name}
          </h3>
          <p className="text-xs text-neutral-500 mt-1">
            Reach more users through social media, SEO, and advertising
          </p>
        </div>
        <Button
          onClick={() => setShowPromoteDialog(true)}
          size="sm"
          className="bg-[#FF5800] hover:bg-[#FF5800]/80 text-white rounded-lg"
        >
          <Megaphone className="h-4 w-4 mr-1.5" />
          Launch Promotion
        </Button>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-neutral-900 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-500/10">
              <Share2 className="h-5 w-5 text-blue-400" />
            </div>
            <div>
              <p className="text-xs text-neutral-500">Social Posts</p>
              <p className="text-xl font-semibold text-white">0</p>
            </div>
          </div>
        </div>

        <div className="bg-neutral-900 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-500/10">
              <Search className="h-5 w-5 text-green-400" />
            </div>
            <div>
              <p className="text-xs text-neutral-500">SEO Score</p>
              <p className="text-xl font-semibold text-white">--</p>
            </div>
          </div>
        </div>

        <div className="bg-neutral-900 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-purple-500/10">
              <TrendingUp className="h-5 w-5 text-purple-400" />
            </div>
            <div>
              <p className="text-xs text-neutral-500">Ad Campaigns</p>
              <p className="text-xl font-semibold text-white">0</p>
            </div>
          </div>
        </div>
      </div>

      {/* Promotional Assets */}
      <div className="bg-neutral-900 rounded-xl p-4 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium text-white flex items-center gap-2">
              <ImageIcon className="h-4 w-4 text-purple-400" />
              Promotional Assets
            </h3>
            <p className="text-xs text-neutral-500 mt-1">
              AI-generated images and copy for your campaigns
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleGenerateAssets}
            disabled={isGeneratingAssets}
            className="border-white/10 hover:bg-white/10 rounded-lg"
          >
            {isGeneratingAssets ? (
              <>
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4 mr-1.5" />
                Generate Assets
              </>
            )}
          </Button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="aspect-square rounded-lg border-2 border-dashed border-white/10 flex flex-col items-center justify-center text-neutral-500 hover:border-white/20 transition-colors cursor-pointer">
            <ImageIcon className="h-6 w-6 mb-1.5" />
            <span className="text-xs">Social Card</span>
          </div>
          <div className="aspect-square rounded-lg border-2 border-dashed border-white/10 flex flex-col items-center justify-center text-neutral-500 hover:border-white/20 transition-colors cursor-pointer">
            <ImageIcon className="h-6 w-6 mb-1.5" />
            <span className="text-xs">Banner</span>
          </div>
          <div className="aspect-square rounded-lg border-2 border-dashed border-white/10 flex flex-col items-center justify-center text-neutral-500 hover:border-white/20 transition-colors cursor-pointer">
            <Video className="h-6 w-6 mb-1.5" />
            <span className="text-xs">Video</span>
          </div>
          <div className="aspect-square rounded-lg border-2 border-dashed border-white/10 flex flex-col items-center justify-center text-neutral-500 hover:border-white/20 transition-colors cursor-pointer">
            <Plus className="h-6 w-6 mb-1.5" />
            <span className="text-xs">Upload</span>
          </div>
        </div>
      </div>

      {/* Suggestions */}
      {suggestions && (
        <div className="bg-neutral-900 rounded-xl p-4 space-y-4">
          <h3 className="text-sm font-medium text-white">Promotion Tips</h3>
          <div className="space-y-2">
            {suggestions.tips.map((tip, index) => (
              <div key={index} className="flex items-start gap-2">
                <div className="w-5 h-5 rounded-full bg-[#FF5800]/10 flex items-center justify-center shrink-0 mt-0.5">
                  <span className="text-[#FF5800] text-[10px] font-semibold">{index + 1}</span>
                </div>
                <p className="text-xs text-neutral-300">{tip}</p>
              </div>
            ))}
          </div>

          <div className="pt-3 border-t border-white/10">
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-500">Estimated budget range:</span>
              <span className="text-white font-medium">
                ${suggestions.estimatedBudget.min} - ${suggestions.estimatedBudget.max}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Connected Ad Accounts */}
      <div className="bg-neutral-900 rounded-xl p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-white">Connected Ad Accounts</h3>
          <Button
            variant="outline"
            size="sm"
            asChild
            className="border-white/10 hover:bg-white/10 rounded-lg"
          >
            <Link to="/dashboard/settings?tab=connections">
              <Plus className="h-4 w-4 mr-1.5" />
              Connect
            </Link>
          </Button>
        </div>

        {adAccounts.length === 0 ? (
          <div className="text-center py-6 text-neutral-500">
            <Megaphone className="h-10 w-10 mx-auto mb-2 opacity-40" />
            <p className="text-xs">No ad accounts connected</p>
            <p className="text-xs text-neutral-600">
              Connect a Meta, Google, or TikTok ads account
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {adAccounts.map((account) => (
              <div
                key={account.id}
                className="flex items-center justify-between p-3 rounded-lg bg-black/30 border border-white/5"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="capitalize text-xs border-white/20">
                    {account.platform}
                  </Badge>
                  <span className="text-sm text-white">{account.accountName}</span>
                </div>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0 rounded-lg">
                  <ExternalLink className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Promote Dialog */}
      <PromoteAppDialog
        open={showPromoteDialog}
        onOpenChange={setShowPromoteDialog}
        app={{
          id: app.id,
          name: app.name,
          description: app.description ?? undefined,
          app_url: app.app_url,
        }}
        adAccounts={adAccounts}
      />
    </div>
  );
}
