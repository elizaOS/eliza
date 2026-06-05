/**
 * Voice status badge component displaying voice clone processing status.
 * Shows ready, processing, or failed states with estimated completion times.
 *
 * @param props.voice - Voice object with clone type and status
 */
"use client";

import { AlertCircle, CheckCircle2, Clock, Loader2 } from "lucide-react";
import { StatusBadge } from "../../../components/ui/status-badge";

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
      <StatusBadge status="success" label="Ready" icon={<CheckCircle2 />} />
    );
  }

  // Professional voice status
  if (voice.status === "failed") {
    return <StatusBadge status="error" label="Failed" icon={<AlertCircle />} />;
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
      <StatusBadge status="success" label="Ready" icon={<CheckCircle2 />} />
    );
  }

  if (minutesElapsed >= minProcessingTime) {
    // Between 30-60 minutes - finalizing
    return <StatusBadge status="warning" label="Finalizing" icon={<Clock />} />;
  }

  // Still processing (under 30 minutes)
  return (
    <StatusBadge status="processing" label="Processing" icon={<Loader2 />} />
  );
}
