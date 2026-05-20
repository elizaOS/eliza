/**
 * Agent Create Component
 *
 * @description Reusable multi-step form for creating a new agent.
 * Used in both the standalone create page and the Agents page.
 */

"use client";

import {
  cn,
  getAgentDefaultProfileImageUrl,
  parseAgentPresetProfileIndex,
  TOTAL_AGENT_DEFAULT_PROFILE_PICTURES,
} from "@feed/shared";
import { Check, Loader2, Wallet, X as XIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
  AgentConfigForm,
  type AgentSettingsData,
  AgentSettingsStep,
  AgentSetupModal,
  ProfilePreviewCard,
} from "@/components/agents/create/components";
import { useAgentForm } from "@/components/agents/create/hooks";
import { Skeleton } from "@/components/shared/Skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useWalletBalance } from "@/hooks/useWalletBalance";
import { apiUrl } from "@/utils/api-url";

const TOTAL_BANNERS = 100;
const DEFAULT_MAX_DEPOSIT = 10000;

enum Step {
  Profile = 1,
  Prompts = 2,
  Settings = 3,
}

/** Agent data returned on successful creation */
interface AgentCreateResult {
  id: string;
  username?: string;
  displayName?: string | null;
  profileImageUrl?: string | null;
  modelTier?: "free" | "pro";
  virtualBalance?: number;
}

interface AgentCreateProps {
  /** Called when back is pressed on step 1 */
  onBack?: () => void;
  /** Called when agent is successfully created */
  onSuccess?: (agent: AgentCreateResult) => void;
  /** Whether to show in compact mode (no page padding) */
  compact?: boolean;
}

/**
 * Agent Create Component
 *
 * Multi-step form for creating a new agent.
 * Can be used standalone or embedded in other views.
 */
export function AgentCreate({
  onBack,
  onSuccess,
  compact = false,
}: AgentCreateProps) {
  const { authenticated, getAccessToken, user: authUser } = useAuth();

  // Fetch balance fresh from API
  const { balance, loading: balanceLoading } = useWalletBalance(authUser?.id, {
    enabled: authenticated,
  });

  const [currentStep, setCurrentStep] = useState<Step>(Step.Profile);
  const [isCreating, setIsCreating] = useState(false);

  // Settings state for step 3
  const [settingsData, setSettingsData] = useState<AgentSettingsData>({
    modelTier: "pro",
    autonomousEnabled: true,
    autonomousPosting: true,
    autonomousCommenting: true,
    autonomousDMs: true,
    autonomousGroupChats: true,
    a2aEnabled: true,
  });

  const {
    profileData,
    agentData,
    isInitialized,
    generatingField,
    updateProfileField,
    updateAgentField,
    regenerateField,
    clearDraft,
  } = useAgentForm();

  // Handle profile modal save (step 1 -> step 2)
  const handleProfileSave = useCallback(
    (data: typeof profileData) => {
      if (data.displayName !== profileData.displayName) {
        updateProfileField("displayName", data.displayName);
      }
      if (data.username !== profileData.username) {
        updateProfileField("username", data.username);
      }
      if (data.bio !== profileData.bio) {
        updateProfileField("bio", data.bio);
      }
      if (data.profileImageUrl !== profileData.profileImageUrl) {
        updateProfileField("profileImageUrl", data.profileImageUrl);
      }
      if (data.coverImageUrl !== profileData.coverImageUrl) {
        updateProfileField("coverImageUrl", data.coverImageUrl);
      }
      setCurrentStep(Step.Prompts);
    },
    [profileData, updateProfileField],
  );

  // Handle continue from step 2 -> step 3
  const handleContinueToSettings = useCallback(() => {
    if (!agentData.system.trim()) {
      toast.error("System prompt is required");
      return;
    }
    setCurrentStep(Step.Settings);
  }, [agentData.system]);

  // User balance for max deposit
  const maxDeposit = Math.max(
    100,
    Math.min(balance || DEFAULT_MAX_DEPOSIT, DEFAULT_MAX_DEPOSIT),
  );

  // Cycle through pre-made images
  const cycleImage = useCallback(
    (type: "profile" | "cover", direction: "next" | "prev") => {
      const bannerBasePath = "/assets/user-banners/banner-";
      const totalImages =
        type === "profile"
          ? TOTAL_AGENT_DEFAULT_PROFILE_PICTURES
          : TOTAL_BANNERS;
      const current =
        type === "profile"
          ? profileData.profileImageUrl
          : profileData.coverImageUrl;

      let currentIndex = 1;
      if (type === "profile") {
        const parsed = parseAgentPresetProfileIndex(current);
        if (parsed !== undefined) currentIndex = parsed;
      } else if (current?.includes(bannerBasePath)) {
        const match = current.match(/-(\d+)\.jpg/);
        if (match) {
          currentIndex = parseInt(match[1]!, 10);
        }
      }

      let nextIndex: number;
      if (direction === "next") {
        nextIndex = currentIndex >= totalImages ? 1 : currentIndex + 1;
      } else {
        nextIndex = currentIndex <= 1 ? totalImages : currentIndex - 1;
      }

      const newUrl =
        type === "profile"
          ? getAgentDefaultProfileImageUrl(nextIndex)
          : `${bannerBasePath}${nextIndex}.jpg`;
      updateProfileField(
        type === "profile" ? "profileImageUrl" : "coverImageUrl",
        newUrl,
      );
    },
    [
      profileData.profileImageUrl,
      profileData.coverImageUrl,
      updateProfileField,
    ],
  );

  // Handle agent creation (step 3)
  const handleCreate = useCallback(async () => {
    // Validation
    if (!profileData.displayName.trim()) {
      toast.error("Agent name is required");
      return;
    }
    if (!profileData.username || profileData.username.length < 3) {
      toast.error("Invalid username. Please set up your agent profile first.");
      return;
    }
    if (!agentData.system.trim()) {
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

    // Split personality by newlines for bio array
    const bioArray = agentData.personality.split("\n").filter((b) => b.trim());

    // Append trading strategy to system prompt
    const systemPrompt = agentData.tradingStrategy.trim()
      ? `${agentData.system}\n\nTrading Strategy: ${agentData.tradingStrategy}`
      : agentData.system;

    // Step 1: Create the agent
    const response = await fetch(apiUrl("/api/agents"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: profileData.displayName,
        username: profileData.username,
        description: profileData.bio,
        profileImageUrl: profileData.profileImageUrl,
        coverImageUrl: profileData.coverImageUrl,
        system: systemPrompt,
        bio: bioArray,
        personality: agentData.personality,
        tradingStrategy: agentData.tradingStrategy,
        initialDeposit: agentData.initialDeposit,
        modelTier: settingsData.modelTier,
        autonomousEnabled: settingsData.autonomousEnabled,
        autonomousPosting: settingsData.autonomousPosting,
        autonomousCommenting: settingsData.autonomousCommenting,
        autonomousDMs: settingsData.autonomousDMs,
        autonomousGroupChats: settingsData.autonomousGroupChats,
        a2aEnabled: settingsData.a2aEnabled,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      toast.error(errorData.error || "Failed to create agent");
      setIsCreating(false);
      return;
    }

    const result = await response.json();
    const agentId = result.agent.id;

    clearDraft();

    // Call success callback with agent info including all relevant fields
    onSuccess?.({
      id: agentId,
      username: profileData.username,
      displayName: profileData.displayName || null,
      profileImageUrl: profileData.profileImageUrl || null,
      modelTier: settingsData.modelTier,
      virtualBalance: agentData.initialDeposit,
    });
  }, [
    profileData,
    agentData,
    settingsData,
    getAccessToken,
    clearDraft,
    onSuccess,
  ]);

  // Step 1 uses its own modal UI
  if (currentStep === Step.Profile) {
    return (
      <AgentSetupModal
        isOpen={true}
        onClose={() => {
          // Close action should dismiss the modal
          // If onBack is provided, use it to navigate back
          if (onBack) {
            onBack();
          }
          // Note: When onBack is not provided, the modal will be rendered without
          // a close button (hideCloseButton prop handles this below)
        }}
        hideCloseButton={!onBack}
        profileData={profileData}
        onSave={handleProfileSave}
      />
    );
  }

  // Scrollable content for steps 2 and 3 (without actions)
  const stepContent = (
    <>
      {currentStep === Step.Prompts && (
        // Step 2: Grid layout with sidebar
        <div className="grid gap-4 sm:gap-8 lg:grid-cols-3">
          {/* Profile Preview - Left Column (hidden on mobile) */}
          <div className="hidden space-y-4 lg:col-span-1 lg:block">
            <ProfilePreviewCard
              profileData={profileData}
              onCycleProfilePic={(direction: "next" | "prev") =>
                cycleImage("profile", direction)
              }
              onCycleBanner={(direction: "next" | "prev") =>
                cycleImage("cover", direction)
              }
              isLoading={!isInitialized}
            />

            {/* Balance Info */}
            <div className="rounded-lg border border-border bg-muted/30 p-4">
              <div className="mb-3 flex items-center gap-2">
                <Wallet className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium text-sm">Funding</span>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Initial Deposit</span>
                  <span className="font-medium font-mono">
                    {agentData.initialDeposit.toLocaleString()} pts
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Your Balance</span>
                  {balanceLoading ? (
                    <span className="h-4 w-16 animate-pulse rounded bg-muted" />
                  ) : (
                    <span className="font-medium font-mono">
                      {balance.toLocaleString()} pts
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Configuration - Right Column */}
          <div className="space-y-4 sm:space-y-6 lg:col-span-2">
            {isInitialized ? (
              <AgentConfigForm
                agentData={agentData}
                generatingField={generatingField}
                maxDeposit={maxDeposit}
                onFieldChange={updateAgentField}
                onRegenerate={regenerateField}
              />
            ) : (
              <div className="space-y-6">
                <div className="space-y-4">
                  <Skeleton className="h-6 w-32" />
                  <Skeleton className="h-32 w-full" />
                </div>
                <div className="space-y-4">
                  <Skeleton className="h-6 w-24" />
                  <Skeleton className="h-24 w-full" />
                </div>
                <div className="space-y-4">
                  <Skeleton className="h-6 w-36" />
                  <Skeleton className="h-28 w-full" />
                </div>
                <div className="space-y-4">
                  <Skeleton className="h-6 w-28" />
                  <Skeleton className="h-10 w-full" />
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {currentStep === Step.Settings && (
        // Step 3: Full-width settings (no sidebar)
        <AgentSettingsStep
          settings={settingsData}
          onSettingsChange={setSettingsData}
        />
      )}
    </>
  );

  // Fixed footer actions for steps 2 and 3
  const stepActions = (
    <div className="flex gap-3">
      {currentStep === Step.Prompts ? (
        <>
          <button
            onClick={() => setCurrentStep(Step.Profile)}
            className={cn(
              "flex-1 rounded-lg border border-border px-4 py-2.5 font-medium transition-colors sm:py-3",
              "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            Back
          </button>
          <button
            onClick={handleContinueToSettings}
            disabled={!isInitialized}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 font-medium transition-all sm:py-3",
              "bg-[#0066FF] text-primary-foreground hover:bg-[#2952d9]",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            Continue
          </button>
        </>
      ) : (
        <>
          <button
            onClick={() => setCurrentStep(Step.Prompts)}
            disabled={isCreating}
            className={cn(
              "flex-1 rounded-lg border border-border px-4 py-2.5 font-medium transition-colors sm:py-3",
              "text-muted-foreground hover:bg-muted hover:text-foreground",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            Back
          </button>
          <button
            onClick={handleCreate}
            disabled={isCreating}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 font-medium transition-all sm:py-3",
              "bg-[#0066FF] text-primary-foreground hover:bg-[#2952d9]",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {isCreating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Creating…
              </>
            ) : (
              "Create Agent"
            )}
          </button>
        </>
      )}
    </div>
  );

  // Step progress indicator (shared by steps 2 + 3)
  const stepProgress = (
    <div className="mx-auto flex w-full max-w-xs items-center justify-center gap-3 py-0">
      {[
        { s: Step.Profile, label: "Profile" },
        { s: Step.Prompts, label: "Prompts" },
        { s: Step.Settings, label: "Settings" },
      ].map(({ s, label }, i, arr) => (
        <div key={s} className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <div
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full font-medium text-xs transition-all",
                currentStep === s
                  ? "bg-[#0066FF] text-white"
                  : currentStep > s
                    ? "bg-green-500 text-white"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {currentStep > s ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                String(i + 1)
              )}
            </div>
            <span className="hidden text-muted-foreground text-xs sm:inline">
              {label}
            </span>
          </div>
          {i < arr.length - 1 && (
            <div
              className={cn(
                "h-0.5 w-6 rounded-full transition-colors",
                currentStep > s ? "bg-green-500" : "bg-muted",
              )}
            />
          )}
        </div>
      ))}
    </div>
  );

  // Modal wrapper with fixed header/footer pattern
  const modalContent = (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-0 backdrop-blur-sm md:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-create-title"
        className="relative flex h-full w-full flex-col bg-background md:h-auto md:max-h-[90vh] md:w-auto md:min-w-[600px] md:max-w-3xl md:rounded-lg md:border md:border-border"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header - fixed */}
        <div className="shrink-0 border-border border-b px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex items-center justify-between">
            <h2 id="agent-create-title" className="font-bold text-lg">
              {currentStep === Step.Prompts
                ? "Configure Prompts"
                : "Agent Settings"}
            </h2>
            {onBack && (
              <button
                onClick={onBack}
                className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Close"
              >
                <XIcon className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>

        {/* Content - scrollable */}
        <div className="flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6">
          {stepContent}
        </div>

        {/* Footer - fixed */}
        <div className="shrink-0 space-y-3 border-border border-t px-4 py-3 sm:px-6 sm:py-4">
          {stepProgress}
          {stepActions}
        </div>
      </div>
    </div>
  );

  // In compact mode (embedded in Command Center), use modal wrapper
  if (compact) {
    return modalContent;
  }

  // Standalone page mode - also use the same fixed header/footer pattern for consistency
  return modalContent;
}
