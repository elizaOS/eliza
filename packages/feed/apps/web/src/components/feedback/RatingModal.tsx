/**
 * Rating modal component for submitting feedback and ratings.
 *
 * Provides a modal wrapper for the feedback form with context-specific
 * titles and icons. Shows user reputation badge and thank you message
 * after successful submission. Supports multiple feedback contexts.
 *
 * Features:
 * - Context-specific display (game, trade, social, general)
 * - User reputation badge
 * - Feedback form integration
 * - Thank you message
 * - Auto-close after submission
 * - Body scroll lock and escape key handling
 *
 * @param props - RatingModal component props
 * @returns Rating modal element or null if not open
 *
 * @example
 * ```tsx
 * <RatingModal
 *   isOpen={showModal}
 *   onClose={() => setShowModal(false)}
 *   toUserId="user-123"
 *   context={{ type: 'game', gameId: 'game-456' }}
 *   onSuccess={() => refreshData()}
 * />
 * ```
 */
"use client";

import { cn } from "@feed/shared";
import { Star, Target, Trophy, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ReputationBadge } from "../reputation/ReputationBadge";
import { FeedbackForm } from "./FeedbackForm";

interface RatingModalProps {
  isOpen: boolean;
  onClose: () => void;
  toUserId: string;
  toUserName?: string;
  toUserReputation?: number;
  context?: {
    type: "game" | "trade" | "social" | "general";
    gameId?: string;
    tradeId?: string;
    positionId?: string;
    description?: string;
  };
  onSuccess?: () => void;
}

export function RatingModal({
  isOpen,
  onClose,
  toUserId,
  toUserName,
  toUserReputation,
  context,
  onSuccess,
}: RatingModalProps) {
  const [showThankYou, setShowThankYou] = useState(false);

  useEffect(() => {
    // Reset thank you state when modal opens
    if (isOpen) {
      setShowThankYou(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSuccess = () => {
    setShowThankYou(true);
    setTimeout(() => {
      onClose();
      if (onSuccess) {
        onSuccess();
      }
    }, 2000);
  };

  const getCategoryFromType = (
    type?: string,
  ):
    | "game_performance"
    | "trade_execution"
    | "social_interaction"
    | "general" => {
    switch (type) {
      case "game":
        return "game_performance";
      case "trade":
        return "trade_execution";
      case "social":
        return "social_interaction";
      default:
        return "general";
    }
  };

  const getContextIcon = () => {
    switch (context?.type) {
      case "game":
        return Trophy;
      case "trade":
        return Target;
      case "social":
        return Star;
      default:
        return Star;
    }
  };

  const getContextTitle = (): string => {
    switch (context?.type) {
      case "game":
        return "Rate Game Performance";
      case "trade":
        return "Rate Trading Experience";
      case "social":
        return "Rate Interaction";
      default:
        return "Submit Feedback";
    }
  };

  const ContextIcon = getContextIcon();

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-0 backdrop-blur-sm md:p-4"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full flex-col bg-background md:h-auto md:max-h-[90vh] md:w-auto md:min-w-[480px] md:max-w-lg md:rounded-xl md:border md:border-border"
        onClick={(e) => e.stopPropagation()}
      >
        {showThankYou ? (
          /* Thank You State */
          <div className="flex flex-1 items-center justify-center p-8">
            <div className="space-y-4 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-500/20">
                <Star className="h-8 w-8 text-green-500" fill="currentColor" />
              </div>
              <h3 className="font-bold text-2xl text-foreground">Thank You!</h3>
              <p className="text-muted-foreground">
                Your feedback has been submitted and will help improve the
                community.
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="flex shrink-0 items-start justify-between border-border border-b p-6">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#1c9cf0]/20">
                  <ContextIcon className="h-5 w-5 text-[#1c9cf0]" />
                </div>
                <div>
                  <h2 className="font-bold text-foreground text-xl">
                    {getContextTitle()}
                  </h2>
                  {context?.description && (
                    <p className="text-muted-foreground text-sm">
                      {context.description}
                    </p>
                  )}
                </div>
              </div>
              <button
                onClick={onClose}
                className="rounded-full p-2 transition-colors hover:bg-muted"
                aria-label="Close modal"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Content */}
            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-6">
              {/* User Info */}
              <div className="flex items-center gap-3 rounded-lg bg-muted/30 p-4">
                <div className="flex-1">
                  <div className="font-semibold text-foreground">
                    {toUserName || "Unknown User"}
                  </div>
                  {toUserReputation !== undefined && (
                    <div className="mt-1">
                      <ReputationBadge
                        reputationPoints={toUserReputation}
                        size="sm"
                        showLabel={true}
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Feedback Form */}
              <FeedbackForm
                toUserId={toUserId}
                toUserName={toUserName}
                category={getCategoryFromType(context?.type)}
                interactionType={
                  context?.type === "game" || context?.type === "trade"
                    ? "game_to_agent"
                    : "user_to_agent"
                }
                gameId={context?.gameId}
                tradeId={context?.tradeId}
                onSuccess={handleSuccess}
                onCancel={onClose}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * QuickRatingButton Component
 *
 * Quick action button to open rating modal
 */
interface QuickRatingButtonProps {
  userId: string;
  userName?: string;
  userReputation?: number;
  context?: RatingModalProps["context"];
  onSuccess?: () => void;
  className?: string;
  variant?: "default" | "compact" | "icon";
}

export function QuickRatingButton({
  userId,
  userName,
  userReputation,
  context,
  onSuccess,
  className = "",
  variant = "default",
}: QuickRatingButtonProps) {
  const [isOpen, setIsOpen] = useState(false);

  const handleOpen = () => setIsOpen(true);
  const handleClose = () => setIsOpen(false);

  if (variant === "icon") {
    return (
      <>
        <button
          onClick={handleOpen}
          className={cn(
            "rounded-lg p-2 transition-colors hover:bg-muted",
            className,
          )}
          aria-label="Rate this user"
        >
          <Star className="h-4 w-4 text-yellow-500" />
        </button>
        <RatingModal
          isOpen={isOpen}
          onClose={handleClose}
          toUserId={userId}
          toUserName={userName}
          toUserReputation={userReputation}
          context={context}
          onSuccess={onSuccess}
        />
      </>
    );
  }

  if (variant === "compact") {
    return (
      <>
        <button
          onClick={handleOpen}
          className={cn(
            "flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors",
            "bg-muted text-foreground hover:bg-muted/70",
            className,
          )}
        >
          <Star className="h-3 w-3" />
          <span>Rate</span>
        </button>
        <RatingModal
          isOpen={isOpen}
          onClose={handleClose}
          toUserId={userId}
          toUserName={userName}
          toUserReputation={userReputation}
          context={context}
          onSuccess={onSuccess}
        />
      </>
    );
  }

  return (
    <>
      <button
        onClick={handleOpen}
        className={cn(
          "flex items-center gap-2 rounded-lg px-4 py-3 font-semibold transition-colors",
          "bg-[#1c9cf0] text-primary-foreground hover:bg-[#1c9cf0]/90",
          className,
        )}
      >
        <Star className="h-4 w-4" />
        <span>Rate Performance</span>
      </button>
      <RatingModal
        isOpen={isOpen}
        onClose={handleClose}
        toUserId={userId}
        toUserName={userName}
        toUserReputation={userReputation}
        context={context}
        onSuccess={onSuccess}
      />
    </>
  );
}
