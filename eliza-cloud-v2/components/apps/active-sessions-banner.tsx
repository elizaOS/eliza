"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { BrandCard, CornerBrackets, BrandButton } from "@/components/brand";
import { Sparkles, Clock, ArrowRight, Loader2, RefreshCw } from "lucide-react";

interface ActiveSession {
  id: string;
  sandboxId: string;
  sandboxUrl: string;
  status: string;
  appName: string | null;
  templateType: string | null;
  createdAt: string;
  expiresAt: string | null;
}

function formatTimeRemaining(expiresAt: string | null): string {
  if (!expiresAt) return "Unknown";
  const now = new Date();
  const expires = new Date(expiresAt);
  const diff = expires.getTime() - now.getTime();

  if (diff <= 0) return "Expired";

  const minutes = Math.floor(diff / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function ActiveSessionsBanner() {
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [, setTick] = useState(0);

  useEffect(() => {
    const fetchSessions = async () => {
      try {
        const response = await fetch("/api/v1/app-builder?limit=5");
        if (response.ok) {
          const data = await response.json();
          if (data.success && data.sessions) {
            const activeSessions = data.sessions.filter(
              (s: ActiveSession) =>
                s.status === "ready" ||
                s.status === "generating" ||
                s.status === "initializing",
            );
            setSessions(activeSessions);
          }
        }
      } catch (error) {
        console.error("Failed to fetch sessions:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchSessions();
  }, []);

  useEffect(() => {
    if (sessions.length === 0) return;

    const interval = setInterval(() => {
      setTick((t) => t + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [sessions.length]);

  if (isLoading) {
    return null;
  }

  if (sessions.length === 0) {
    return null;
  }

  return (
    <BrandCard className="border-l-4 border-l-[#FF5800]">
      <CornerBrackets size="sm" className="opacity-20" />
      <div className="relative z-10">
        <div className="flex items-center gap-2 mb-4">
          <div className="p-2 bg-[#FF5800]/20 rounded-lg">
            <Sparkles className="h-4 w-4 text-[#FF5800]" />
          </div>
          <div>
            <h3 className="font-semibold text-white">Active Build Sessions</h3>
            <p className="text-xs text-white/60">Continue where you left off</p>
          </div>
        </div>

        <div className="space-y-3">
          {sessions.map((session) => (
            <div
              key={session.id}
              className="flex items-center justify-between p-3 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div
                  className={`w-2 h-2 rounded-full ${
                    session.status === "ready"
                      ? "bg-green-500"
                      : session.status === "generating"
                        ? "bg-yellow-500 animate-pulse"
                        : "bg-blue-500 animate-pulse"
                  }`}
                />
                <div>
                  <p className="text-sm font-medium text-white">
                    {session.appName || "Untitled App"}
                  </p>
                  <div className="flex items-center gap-2 text-xs text-white/50">
                    <span className="capitalize">
                      {session.templateType || "blank"}
                    </span>
                    <span>•</span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {formatTimeRemaining(session.expiresAt)}
                    </span>
                  </div>
                </div>
              </div>

              <Link
                href={`/dashboard/apps/create?sessionId=${session.id}`}
                className="flex items-center gap-1 px-3 py-1.5 bg-[#FF5800]/20 hover:bg-[#FF5800]/30 text-[#FF5800] text-sm font-medium rounded transition-colors"
              >
                Continue
                <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
          ))}
        </div>
      </div>
    </BrandCard>
  );
}
