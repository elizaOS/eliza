"use client";

/**
 * SessionLoader - Unified loading component for app builder sessions
 *
 * Clean, minimal loading experience with smooth transitions between states.
 * All modes share the same visual language for a cohesive feel.
 */

import { useEffect, useState, useMemo } from "react";
import {
  Check,
  RefreshCw,
  AlertCircle,
  Timer,
  Sparkles,
  GitBranch,
  Rocket,
  Cloud,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  ProgressStep,
  SnapshotInfo,
  AppSnapshotInfo,
} from "@/lib/app-builder/types";
import { Button } from "@/components/ui/button";

// Phase definitions for the loading sequence
const PHASES = [
  {
    key: "creating",
    label: "Initializing sandbox",
    icon: Sparkles,
    color: "text-[#FF5800]",
  },
  {
    key: "installing",
    label: "Installing packages",
    icon: GitBranch,
    color: "text-cyan-400",
  },
  {
    key: "starting",
    label: "Starting dev server",
    icon: Rocket,
    color: "text-violet-400",
  },
] as const;

type LoaderMode =
  | "initializing" // Initial page load
  | "starting" // Starting new sandbox
  | "restoring" // Restoring from GitHub
  | "expired" // Session timed out
  | "error"; // Error state

interface SessionLoaderProps {
  mode: LoaderMode;
  progressStep?: ProgressStep;
  restoreProgress?: { current: number; total: number; filePath: string } | null;
  snapshotInfo?: SnapshotInfo | null;
  appSnapshotInfo?: AppSnapshotInfo | null;
  errorMessage?: string | null;
  appName?: string;
  backLink?: string;
  onRestore?: () => void;
  onStartNew?: () => void;
  onRetry?: () => void;
  onBack?: () => void;
  isRestoring?: boolean;
  /** Direct GitHub repo string from appData - used as fallback for restore capability */
  appGithubRepo?: string | null;
}

// Unified spinner with colorful gradient
function LoadingSpinner({ size = "lg" }: { size?: "sm" | "lg" }) {
  const sizeClasses = size === "lg" ? "w-12 h-12" : "w-8 h-8";

  return (
    <div className={cn("relative", sizeClasses)}>
      {/* Outer gradient ring */}
      <div
        className="absolute inset-0 rounded-full animate-spin"
        style={{
          background:
            "conic-gradient(from 0deg, #FF5800, #06B6D4, #8B5CF6, #FF5800)",
          animationDuration: "2s",
        }}
      />
      {/* Inner cutout */}
      <div className="absolute inset-[3px] rounded-full bg-[#0A0A0A]" />
      {/* Center glow */}
      <div className="absolute inset-[6px] rounded-full bg-gradient-to-br from-white/5 to-transparent" />
    </div>
  );
}

// Progress step indicator with vertical connector line
function StepIndicator({
  isActive,
  isComplete,
  isLast,
  icon: Icon,
  label,
  color,
}: {
  isActive: boolean;
  isComplete: boolean;
  isLast: boolean;
  icon: typeof Sparkles;
  label: string;
  color: string;
}) {
  return (
    <div className="relative flex items-start">
      {/* Left column: icon + vertical line */}
      <div className="relative flex flex-col items-center">
        {/* Icon container */}
        <div
          className={cn(
            "relative z-10 w-8 h-8 rounded-xl flex items-center justify-center transition-all duration-500 flex-shrink-0",
            isComplete && "bg-emerald-500/20 border border-emerald-500/30",
            isActive && "bg-white/10 border border-white/20",
            !isActive && !isComplete && "bg-white/5 border border-white/10",
          )}
        >
          {isComplete ? (
            <Check className="w-4 h-4 text-emerald-400" strokeWidth={2.5} />
          ) : isActive ? (
            <Loader2
              className={cn(
                "w-4 h-4 animate-spin",
                color === "text-[#FF5800]"
                  ? "text-[#FF5800]"
                  : color === "text-cyan-400"
                    ? "text-cyan-400"
                    : "text-violet-400",
              )}
            />
          ) : (
            <Icon
              className={cn(
                "w-4 h-4 transition-colors duration-500",
                "text-white/40",
              )}
            />
          )}
        </div>

        {/* Vertical connector line - bridges to next step */}
        {!isLast && (
          <div
            className={cn(
              "w-[2px] h-3 transition-all duration-500",
              isComplete ? "bg-emerald-500/40" : "bg-white/10",
            )}
          />
        )}
      </div>

      {/* Right column: label and status */}
      <div
        className={cn(
          "flex-1 min-w-0 ml-3 min-h-8 flex items-center transition-all duration-500",
          isActive && "scale-[1.02] origin-left",
          !isActive && !isComplete && "opacity-40",
        )}
      >
        <div className="flex-1">
          <p
            className={cn(
              "text-sm font-medium transition-colors duration-500",
              isComplete && "text-emerald-400",
              isActive && "text-white",
              !isActive && !isComplete && "text-white/40",
            )}
          >
            {label}
          </p>
        </div>

        {/* Status indicator */}
        {isActive && (
          <div className="flex gap-1 flex-shrink-0 ml-3">
            <span
              className="w-1.5 h-1.5 rounded-full bg-white/60 animate-pulse"
              style={{ animationDelay: "0ms" }}
            />
            <span
              className="w-1.5 h-1.5 rounded-full bg-white/60 animate-pulse"
              style={{ animationDelay: "150ms" }}
            />
            <span
              className="w-1.5 h-1.5 rounded-full bg-white/60 animate-pulse"
              style={{ animationDelay: "300ms" }}
            />
          </div>
        )}
        {isComplete && (
          <span className="text-xs text-emerald-400/60 flex-shrink-0 ml-3">
            Done
          </span>
        )}
      </div>
    </div>
  );
}

export function SessionLoader({
  mode,
  progressStep = "creating",
  restoreProgress,
  snapshotInfo,
  appSnapshotInfo,
  errorMessage,
  appName,
  backLink = "/dashboard/apps",
  onRestore,
  onStartNew,
  onRetry,
  onBack,
  isRestoring,
  appGithubRepo,
}: SessionLoaderProps) {
  const [dots, setDots] = useState("");

  // Animate dots for loading text
  useEffect(() => {
    if (mode === "expired" || mode === "error") return;
    const interval = setInterval(() => {
      setDots((d) => (d.length >= 3 ? "" : d + "."));
    }, 400);
    return () => clearInterval(interval);
  }, [mode]);

  const currentStepIndex = PHASES.findIndex((p) => p.key === progressStep);
  // Include appGithubRepo as a fallback source for restore capability
  const githubRepo =
    snapshotInfo?.githubRepo || appSnapshotInfo?.githubRepo || appGithubRepo;
  const canRestore =
    snapshotInfo?.canRestore ||
    !!appSnapshotInfo?.githubRepo ||
    !!appGithubRepo;

  // Unified title logic - feels like one continuous experience
  const title = useMemo(() => {
    if (mode === "error") return "Something went wrong";
    if (mode === "expired") return "Session Expired";
    if (appName) return appName;
    return "Loading";
  }, [mode, appName]);

  // Subtitle changes based on actual progress
  const subtitle = useMemo(() => {
    if (mode === "error")
      return errorMessage || "Failed to start the development environment";
    if (mode === "expired") return "Your sandbox session has timed out";
    if (mode === "initializing") return "Connecting to your workspace";
    if (mode === "restoring" && restoreProgress) {
      return `Restoring files (${restoreProgress.current}/${restoreProgress.total})`;
    }
    if (mode === "restoring") return "Recovering from GitHub";
    // For starting mode, show current phase
    const phase = PHASES[currentStepIndex];
    if (phase) return phase.label;
    return "Setting up your environment";
  }, [mode, errorMessage, restoreProgress, currentStepIndex]);

  // Show progress steps ONLY for starting mode (new sandbox creation)
  // Restoring mode has its own restore progress bar, not the 3-step setup indicator
  const showProgress = mode === "starting";

  // Icon and color based on mode
  const modeIcon = useMemo(() => {
    if (mode === "error")
      return <AlertCircle className="w-6 h-6 text-red-400" />;
    if (mode === "expired") return <Timer className="w-6 h-6 text-amber-400" />;
    if (mode === "restoring")
      return <Cloud className="w-6 h-6 text-emerald-400" />;
    return null;
  }, [mode]);

  return (
    <div className="w-full max-w-lg mx-auto px-6">
      {/* Main content */}
      <div className="text-center space-y-5">
        {/* Spinner or mode icon */}
        <div className="flex justify-center">
          {mode === "error" || mode === "expired" ? (
            <div
              className={cn(
                "w-12 h-12 rounded-xl flex items-center justify-center",
                mode === "error" && "bg-red-500/10 border border-red-500/20",
                mode === "expired" &&
                  "bg-amber-500/10 border border-amber-500/20",
              )}
            >
              {modeIcon}
            </div>
          ) : (
            <LoadingSpinner />
          )}
        </div>

        {/* Title and subtitle */}
        <div className="space-y-1">
          <h1 className="text-xl font-semibold text-white tracking-tight">
            {title}
          </h1>
          <p className="text-white/50 text-sm">
            {subtitle}
            {mode !== "error" && mode !== "expired" && (
              <span className="inline-block w-6 text-left">{dots}</span>
            )}
          </p>
        </div>

        {/* GitHub badge for restoring */}
        {githubRepo && (mode === "restoring" || mode === "initializing") && (
          <div className="flex justify-center">
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-full">
              <GitBranch className="w-4 h-4 text-emerald-400" />
              <span className="text-sm text-emerald-400 font-mono">
                {githubRepo.split("/").pop()}
              </span>
            </div>
          </div>
        )}

        {/* Progress steps */}
        {showProgress && (
          <div className="text-left max-w-sm mx-auto pt-2">
            {PHASES.map((phase, index) => (
              <StepIndicator
                key={phase.key}
                isActive={index === currentStepIndex}
                isComplete={index < currentStepIndex}
                isLast={index === PHASES.length - 1}
                icon={phase.icon}
                label={phase.label}
                color={phase.color}
              />
            ))}
          </div>
        )}

        {/* Restore progress bar */}
        {mode === "restoring" && restoreProgress && (
          <div className="max-w-sm mx-auto space-y-3 pt-4">
            <div className="h-2 bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-emerald-500 to-cyan-400 rounded-full transition-all duration-300"
                style={{
                  width: `${(restoreProgress.current / restoreProgress.total) * 100}%`,
                }}
              />
            </div>
            <p className="text-xs text-white/40 font-mono truncate">
              {restoreProgress.filePath}
            </p>
          </div>
        )}

        {/* Error actions */}
        {mode === "error" && (
          <div className="space-y-3 max-w-xs mx-auto pt-4">
            <Button
              onClick={onRetry}
              className="w-full bg-white/10 hover:bg-white/15 text-white border border-white/10"
            >
              <RefreshCw className="w-4 h-4 mr-2" />
              Try Again
            </Button>
            <Button
              variant="ghost"
              onClick={onBack}
              className="w-full text-white/50 hover:text-white/70"
            >
              Return to Apps
            </Button>
          </div>
        )}

        {/* Expired actions */}
        {mode === "expired" && (
          <div className="space-y-4 max-w-xs mx-auto pt-4">
            {canRestore && githubRepo && (
              <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-left">
                <div className="flex items-center gap-2 mb-1">
                  <Cloud className="w-4 h-4 text-emerald-400" />
                  <span className="text-sm font-medium text-emerald-400">
                    Code saved
                  </span>
                </div>
                <p className="text-xs text-white/50 font-mono">
                  {githubRepo.split("/").pop()}
                </p>
              </div>
            )}

            {canRestore ? (
              <Button
                onClick={onRestore}
                disabled={isRestoring}
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white"
              >
                {isRestoring ? (
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4 mr-2" />
                )}
                Restore & Continue
              </Button>
            ) : (
              <Button
                onClick={onStartNew}
                className="w-full bg-[#FF5800] hover:bg-[#FF5800]/80 text-white"
              >
                <Sparkles className="w-4 h-4 mr-2" />
                Start New Session
              </Button>
            )}

            <Button
              variant="ghost"
              onClick={onBack}
              className="w-full text-white/50 hover:text-white/70"
            >
              Return to Apps
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
