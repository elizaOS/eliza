/**
 * Voice status badge component displaying voice clone processing status.
 * Shows ready, processing, or failed states with estimated completion times.
 *
 * @param props - Voice status badge configuration
 * @param props.voice - Voice object with clone type and status
 */
"use client";

import { Badge } from "@/components/ui/badge";
import { Loader2, Clock, CheckCircle2, AlertCircle } from "lucide-react";

interface VoiceStatusBadgeProps {
  voice: {
    cloneType: "instant" | "professional";
    createdAt: Date | string;
    status?: "processing" | "completed" | "failed";
  };
}

export function VoiceStatusBadge({ voice }: VoiceStatusBadgeProps) {
  // Instant voices are ready immediately
  if (voice.cloneType === "instant") {
    return (
      <Badge
        variant="default"
        className="bg-green-500/10 text-green-600 border-green-500/20"
      >
        <CheckCircle2 className="mr-1 h-3 w-3" />
        Ready
      </Badge>
    );
  }

  // Professional voice status
  if (voice.status === "failed") {
    return (
      <Badge variant="destructive">
        <AlertCircle className="mr-1 h-3 w-3" />
        Failed
      </Badge>
    );
  }

  // Calculate time elapsed safely
  const createdAt = new Date(voice.createdAt);
  const now = new Date();
  const minutesElapsed = Math.max(
    0,
    (now.getTime() - createdAt.getTime()) / 1000 / 60,
  );

  const minProcessingTime = 30; // 30 minutes minimum
  const maxProcessingTime = 60; // 60 minutes maximum

  if (minutesElapsed >= maxProcessingTime) {
    // Over 60 minutes - should be ready
    return (
      <Badge
        variant="default"
        className="bg-green-500/10 text-green-600 border-green-500/20"
      >
        <CheckCircle2 className="mr-1 h-3 w-3" />
        Ready
      </Badge>
    );
  }

  if (minutesElapsed >= minProcessingTime) {
    // Between 30-60 minutes - finalizing
    return (
      <Badge
        variant="outline"
        className="border-amber-500/50 bg-amber-500/5 text-amber-600"
      >
        <Clock className="mr-1 h-3 w-3" />
        Finalizing
      </Badge>
    );
  }

  // Still processing (under 30 minutes)
  return (
    <Badge
      variant="outline"
      className="border-amber-500/50 bg-amber-500/5 text-amber-600"
    >
      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
      Processing
    </Badge>
  );
}

export function getEstimatedReadyMessage(voice: {
  cloneType: "instant" | "professional";
  createdAt: Date | string;
  name: string;
}): string {
  if (voice.cloneType === "instant") {
    return `"${voice.name}" is ready to use.`;
  }

  // Professional voice
  const createdAt = new Date(voice.createdAt);
  const now = new Date();
  const minutesElapsed = Math.max(
    0,
    (now.getTime() - createdAt.getTime()) / 1000 / 60,
  );

  const minMinutes = 30;
  const maxMinutes = 60;

  if (minutesElapsed < minMinutes) {
    return `"${voice.name}" is being processed. Professional voice clones typically take 30-60 minutes. Please check back later or click "Refresh" to see if it's ready.`;
  }

  if (minutesElapsed < maxMinutes) {
    return `"${voice.name}" should be ready soon. Click "Refresh" to check status.`;
  }

  return `"${voice.name}" should be ready now. Click "Refresh" to verify.`;
}
