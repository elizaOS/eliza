/**
 * App monetization settings component with enhanced UX.
 * Features hero status card, earnings simulator, and visual revenue flow diagram.
 */

"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  EarningsSimulator,
  RevenueFlowDiagram,
  Slider,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@elizaos/cloud-ui";
import { ChevronRight, Coins, DollarSign, Info, Loader2, Save, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface MonetizationSettings {
  monetizationEnabled: boolean;
  inferenceMarkupPercentage: number;
  purchaseSharePercentage: number;
  platformOffsetAmount: number;
  totalCreatorEarnings: number;
}

interface AppMonetizationSettingsProps {
  appId: string;
}

export function AppMonetizationSettings({ appId }: AppMonetizationSettingsProps) {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [settings, setSettings] = useState<MonetizationSettings>({
    monetizationEnabled: false,
    inferenceMarkupPercentage: 0,
    purchaseSharePercentage: 10,
    platformOffsetAmount: 1,
    totalCreatorEarnings: 0,
  });
  const [hasChanges, setHasChanges] = useState(false);
  const [showEnableDialog, setShowEnableDialog] = useState(false);

  useEffect(() => {
    const fetchSettings = async () => {
      setIsLoading(true);
      try {
        const response = await fetch(`/api/v1/apps/${appId}/monetization`);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const data = await response.json();
        if (data.success && data.monetization) {
          setSettings(data.monetization);
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to load settings");
      } finally {
        setIsLoading(false);
      }
    };
    fetchSettings();
  }, [appId]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const response = await fetch(`/api/v1/apps/${appId}/monetization`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          monetizationEnabled: settings.monetizationEnabled,
          inferenceMarkupPercentage: settings.inferenceMarkupPercentage,
          purchaseSharePercentage: settings.purchaseSharePercentage,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to save settings");
      }
      toast.success("Settings saved");
      setHasChanges(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save settings");
    } finally {
      setIsSaving(false);
    }
  };

  const updateSetting = <K extends keyof MonetizationSettings>(
    key: K,
    value: MonetizationSettings[K],
  ) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const toggleMonetization = async (enabled: boolean) => {
    setSettings((prev) => ({ ...prev, monetizationEnabled: enabled }));
    try {
      const response = await fetch(`/api/v1/apps/${appId}/monetization`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          monetizationEnabled: enabled,
          inferenceMarkupPercentage: settings.inferenceMarkupPercentage,
          purchaseSharePercentage: settings.purchaseSharePercentage,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to update monetization");
      }
      toast.success(enabled ? "Monetization enabled" : "Monetization disabled");
    } catch (error) {
      // Revert on failure
      setSettings((prev) => ({ ...prev, monetizationEnabled: !enabled }));
      toast.error(error instanceof Error ? error.message : "Failed to update monetization");
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-[#FF5800]" />
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* Monetization Toggle Card */}
        <div
          className={cn(
            "rounded-xl p-4 border transition-colors",
            settings.monetizationEnabled
              ? "bg-emerald-500/5 border-emerald-500/20"
              : "bg-neutral-900 border-white/10",
          )}
        >
          <div className="flex items-start gap-3">
            <div
              className={cn(
                "p-2 rounded-lg mt-0.5",
                settings.monetizationEnabled ? "bg-emerald-500/10" : "bg-white/5",
              )}
            >
              <DollarSign
                className={cn(
                  "h-5 w-5",
                  settings.monetizationEnabled ? "text-emerald-400" : "text-white/40",
                )}
              />
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-white">
                  {settings.monetizationEnabled ? "Monetization Active" : "Enable Monetization"}
                </p>
                <Switch
                  checked={settings.monetizationEnabled}
                  onCheckedChange={(checked) => {
                    if (checked && !settings.monetizationEnabled) {
                      setShowEnableDialog(true);
                    } else {
                      toggleMonetization(checked);
                    }
                  }}
                  className="data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-neutral-700"
                />
              </div>
              <p className="text-xs text-neutral-500 mt-1">
                {settings.monetizationEnabled
                  ? "Earning from inference markups and credit purchases. Users pay app-specific credits."
                  : "Start earning from your app. You'll earn from inference markups and credit purchases."}
              </p>
              {settings.totalCreatorEarnings > 0 && (
                <button
                  onClick={() => navigate(`/dashboard/apps/${appId}?tab=earnings`)}
                  className="mt-2 text-xs text-[#FF5800] hover:text-[#FF5800]/80 transition-colors flex items-center gap-1"
                >
                  ${settings.totalCreatorEarnings.toFixed(2)} earned
                  <ChevronRight className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Settings Grid */}
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Markup Controls */}
          <div className="bg-neutral-900 rounded-xl p-4 space-y-4">
            <h3 className="text-sm font-medium text-white">Revenue Settings</h3>

            {/* Inference Markup */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-white">Inference Markup</span>
                  <Tooltip>
                    <TooltipTrigger>
                      <Info className="h-3.5 w-3.5 text-neutral-500" />
                    </TooltipTrigger>
                    <TooltipContent
                      side="right"
                      className="max-w-[200px] bg-neutral-800 border-white/10 text-white"
                    >
                      Markup on LLM costs. Higher = more per request.
                    </TooltipContent>
                  </Tooltip>
                </div>
                <span className="text-lg font-mono font-semibold text-purple-400">
                  {settings.inferenceMarkupPercentage}%
                </span>
              </div>
              <Slider
                value={[settings.inferenceMarkupPercentage]}
                onValueChange={([value]) => updateSetting("inferenceMarkupPercentage", value)}
                min={0}
                max={500}
                step={5}
                className="w-full"
              />
              <div className="flex gap-1.5 flex-wrap">
                {[0, 25, 50, 100, 200].map((preset) => (
                  <button
                    key={preset}
                    className={cn(
                      "px-2.5 py-1 text-xs rounded-lg transition-colors",
                      settings.inferenceMarkupPercentage === preset
                        ? "bg-purple-500/20 text-purple-400 border border-purple-500/30"
                        : "bg-white/5 text-neutral-400 hover:bg-white/10 border border-transparent",
                    )}
                    onClick={() => updateSetting("inferenceMarkupPercentage", preset)}
                  >
                    {preset}%
                  </button>
                ))}
              </div>
            </div>

            <div className="h-px bg-white/10" />

            {/* Purchase Share */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-white">Purchase Share</span>
                  <Tooltip>
                    <TooltipTrigger>
                      <Info className="h-3.5 w-3.5 text-neutral-500" />
                    </TooltipTrigger>
                    <TooltipContent
                      side="right"
                      className="max-w-[200px] bg-neutral-800 border-white/10 text-white"
                    >
                      Your cut of credit purchases after platform fee.
                    </TooltipContent>
                  </Tooltip>
                </div>
                <span className="text-lg font-mono font-semibold text-amber-400">
                  {settings.purchaseSharePercentage}%
                </span>
              </div>
              <Slider
                value={[settings.purchaseSharePercentage]}
                onValueChange={([value]) => updateSetting("purchaseSharePercentage", value)}
                min={0}
                max={50}
                step={5}
                className="w-full"
              />
              <div className="flex gap-1.5 flex-wrap">
                {[0, 10, 20, 30, 50].map((preset) => (
                  <button
                    key={preset}
                    className={cn(
                      "px-2.5 py-1 text-xs rounded-lg transition-colors",
                      settings.purchaseSharePercentage === preset
                        ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                        : "bg-white/5 text-neutral-400 hover:bg-white/10 border border-transparent",
                    )}
                    onClick={() => updateSetting("purchaseSharePercentage", preset)}
                  >
                    {preset}%
                  </button>
                ))}
              </div>
            </div>

            {/* Save Button */}
            <div className="pt-2">
              <Button
                onClick={handleSave}
                disabled={!hasChanges || isSaving}
                className="w-full bg-[#FF5800] hover:bg-[#FF5800]/80 text-white disabled:bg-white/5 disabled:text-white/30"
              >
                {isSaving ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <Save className="h-4 w-4 mr-2" />
                )}
                Save Changes
              </Button>
            </div>
          </div>

          {/* Revenue Flow Diagram */}
          <RevenueFlowDiagram
            markupPercentage={settings.inferenceMarkupPercentage}
            purchaseSharePercentage={settings.purchaseSharePercentage}
          />
        </div>

        {/* Earnings Simulator */}
        <EarningsSimulator
          markupPercentage={settings.inferenceMarkupPercentage}
          purchaseSharePercentage={settings.purchaseSharePercentage}
        />

        {/* Self-Host CTA — closes the loop: app earns → fund refills → container stays alive */}
        {settings.monetizationEnabled && <SelfHostCTA />}

        {/* Enable Monetization Confirmation Dialog */}
        <AlertDialog open={showEnableDialog} onOpenChange={setShowEnableDialog}>
          <AlertDialogContent className="bg-neutral-900 border-white/10">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-white text-center sm:text-left">
                Enable Monetization?
              </AlertDialogTitle>
              <AlertDialogDescription className="text-neutral-400 space-y-3 text-left">
                <p>When monetization is enabled, users of your app will:</p>
                <ul className="list-disc list-inside space-y-1 text-sm">
                  <li>Pay app-specific credits (separate balance)</li>
                  <li>See inference costs with your markup applied</li>
                  <li>Purchase credits that contribute to your earnings</li>
                </ul>
                <p className="pt-2 text-[#FF5800] text-sm">
                  You can adjust markup and purchase share after enabling.
                </p>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="gap-2 sm:gap-2">
              <AlertDialogCancel className="border-0 bg-transparent text-neutral-400 hover:text-white hover:bg-transparent">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  toggleMonetization(true);
                  setShowEnableDialog(false);
                }}
                className="bg-[#FF5800] hover:bg-[#FF5800]/80 text-white px-6"
              >
                Start Earning
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
}

/**
 * Self-hosting CTA shown only when monetization is on. Tells the loop
 * story: deploy the app as its own container — your earnings will pay
 * the daily hosting bill automatically, no settings required. Cashout
 * still works any time via the Earnings page.
 */
function SelfHostCTA() {
  return (
    <div className="border border-[#FF5800]/30 bg-gradient-to-br from-[#FF5800]/5 to-transparent p-5">
      <div className="flex items-start gap-4">
        <div className="hidden sm:flex items-center justify-center w-10 h-10 rounded-none border border-[#FF5800]/40 bg-[#FF5800]/10 shrink-0">
          <Server className="h-5 w-5 text-[#FF5800]" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-mono text-white mb-1">Let this app host itself.</h3>
          <p className="text-sm text-white/60 mb-3">
            Deploy as a container — daily hosting bills are paid from your app earnings first, then
            your credits. No setup, no settings. Cashout still works whenever you want.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              to="/dashboard/containers"
              className="inline-flex items-center gap-2 px-4 py-2 bg-[#FF5800] hover:bg-[#FF5800]/90 text-white text-sm font-mono transition-colors"
            >
              <Server className="h-4 w-4" />
              Deploy a Container
            </Link>
            <Link
              to="/dashboard/earnings"
              className="inline-flex items-center gap-2 px-4 py-2 border border-white/20 hover:border-[#FF5800]/50 text-white/80 hover:text-white text-sm font-mono transition-colors"
            >
              <Coins className="h-4 w-4" />
              View Earnings
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
