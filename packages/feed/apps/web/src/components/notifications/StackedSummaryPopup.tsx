"use client";

import { cn } from "@feed/shared";
import { AnimatePresence, motion } from "framer-motion";
import { Bell, ChevronRight, TrendingDown, TrendingUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ConfettiCanvas,
  type OutcomeNotification,
} from "./OutcomeNotificationPopup";

const AUTO_DISMISS_MS = 12000;

interface StackedSummaryPopupProps {
  notifications: OutcomeNotification[];
  onDismiss: () => void;
  /** Called when user taps a specific result to navigate */
  onViewResult: (notification: OutcomeNotification) => void;
}

export function StackedSummaryPopup({
  notifications,
  onDismiss,
  onViewResult,
}: StackedSummaryPopupProps) {
  const router = useRouter();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remainingRef = useRef(AUTO_DISMISS_MS);
  const startedAtRef = useRef(0);
  const [paused, setPaused] = useState(false);
  const isOpen = notifications.length > 0;

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(
    (ms: number) => {
      clearTimer();
      remainingRef.current = ms;
      startedAtRef.current = Date.now();
      timerRef.current = setTimeout(onDismiss, ms);
    },
    [onDismiss, clearTimer],
  );

  const pauseTimer = useCallback(() => {
    if (timerRef.current) {
      const elapsed = Date.now() - startedAtRef.current;
      remainingRef.current = Math.max(0, remainingRef.current - elapsed);
      clearTimer();
    }
    setPaused(true);
  }, [clearTimer]);

  const resumeTimer = useCallback(() => {
    setPaused(false);
    if (!timerRef.current && remainingRef.current > 0) {
      startTimer(remainingRef.current);
    }
  }, [startTimer]);

  useEffect(() => {
    if (!isOpen) return;

    startTimer(AUTO_DISMISS_MS);

    return clearTimer;
  }, [isOpen, startTimer, clearTimer]);

  useEffect(() => {
    if (!isOpen) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  const wins = notifications.filter((n) => n.outcome === "win");
  const losses = notifications.filter((n) => n.outcome === "loss");
  const totalPoints = notifications.reduce((sum, n) => sum + n.points, 0);
  const isNetPositive = totalPoints >= 0;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          key="stacked-summary"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="fixed inset-0 z-[110] flex items-center justify-center"
        >
          {/* Backdrop */}
          <div
            className={cn(
              "absolute inset-0 backdrop-blur-md",
              isNetPositive ? "bg-green-950/20" : "bg-black/70",
            )}
            onClick={onDismiss}
          />

          {/* Confetti when net positive */}
          {isNetPositive && <ConfettiCanvas />}

          {/* Card */}
          <motion.div
            initial={{ scale: 0.85, opacity: 0, y: 40 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0, y: 20 }}
            transition={{ type: "spring", damping: 20, stiffness: 300 }}
            onMouseEnter={pauseTimer}
            onMouseLeave={resumeTimer}
            className="relative z-10 mx-4 w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
          >
            {/* Header */}
            <div className="relative flex flex-col items-center bg-gradient-to-b from-primary/10 to-transparent px-6 pt-8 pb-8">
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{
                  type: "spring",
                  damping: 12,
                  stiffness: 200,
                  delay: 0.15,
                }}
                className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 ring-2 ring-primary/20"
              >
                <Bell className="h-8 w-8 text-primary" />
              </motion.div>

              <motion.h2
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2, duration: 0.3 }}
                className="font-bold text-foreground text-xl"
              >
                {notifications.length} markets resolved
              </motion.h2>

              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3, duration: 0.3 }}
                className="mt-1 text-muted-foreground text-sm"
              >
                while you were away
              </motion.p>
            </div>

            {/* Summary stats */}
            <div className="px-6 pb-2">
              <div className="flex items-center justify-center gap-4">
                {wins.length > 0 && (
                  <div className="rounded-lg bg-green-500/10 px-3 py-1.5">
                    <span className="font-semibold text-green-500 text-sm">
                      {wins.length} won
                    </span>
                  </div>
                )}
                {losses.length > 0 && (
                  <div className="rounded-lg bg-red-500/10 px-3 py-1.5">
                    <span className="font-semibold text-red-500 text-sm">
                      {losses.length} lost
                    </span>
                  </div>
                )}
              </div>

              {/* Net points */}
              <div className="mt-3 flex items-center justify-center gap-1">
                {isNetPositive ? (
                  <TrendingUp className="h-4 w-4 text-green-500" />
                ) : (
                  <TrendingDown className="h-4 w-4 text-red-500" />
                )}
                <span
                  className={cn(
                    "font-bold text-lg",
                    isNetPositive ? "text-green-500" : "text-red-500",
                  )}
                >
                  {totalPoints >= 0 ? "+" : ""}
                  {totalPoints.toLocaleString("en-US", {
                    maximumFractionDigits: 0,
                  })}{" "}
                  pts net
                </span>
              </div>
            </div>

            {/* Individual results list */}
            <div className="scrollbar-hide mx-6 mt-3 max-h-48 overflow-y-auto overflow-x-hidden">
              {notifications.map((n) => {
                const isWin = n.outcome === "win";
                return (
                  <button
                    key={n.id}
                    onClick={() => {
                      clearTimer();
                      onViewResult(n);
                      // Guard against open redirects — deep links must be relative paths
                      const safeLink = n.deepLink.startsWith("/")
                        ? n.deepLink
                        : "/";
                      router.push(safeLink);
                    }}
                    className="group flex w-full items-center gap-3 rounded-lg py-2 text-left transition-colors hover:bg-muted/30"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground text-sm">
                        {n.marketName}
                      </p>
                      {n.agentName && (
                        <p className="text-muted-foreground text-xs">
                          via {n.agentName}
                        </p>
                      )}
                    </div>
                    <span
                      className={cn(
                        "shrink-0 font-semibold text-sm",
                        isWin ? "text-green-500" : "text-red-500",
                      )}
                    >
                      {n.points >= 0 ? "+" : ""}
                      {n.points.toLocaleString("en-US", {
                        maximumFractionDigits: 0,
                      })}
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-1" />
                  </button>
                );
              })}
            </div>

            {/* Dismiss button */}
            <div className="mt-4 px-6 pb-5">
              <button
                onClick={onDismiss}
                className="flex w-full items-center justify-center gap-1 rounded-lg border border-border py-2.5 font-medium text-foreground text-sm transition-colors hover:bg-muted/50"
              >
                Dismiss
              </button>
            </div>

            {/* Auto-dismiss progress bar */}
            <div
              className="h-0.5 origin-left rounded-bl-2xl bg-primary"
              style={{
                transform: "scaleX(1)",
                animation: `shrink-bar ${AUTO_DISMISS_MS}ms linear forwards`,
                animationPlayState: paused ? "paused" : "running",
              }}
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
