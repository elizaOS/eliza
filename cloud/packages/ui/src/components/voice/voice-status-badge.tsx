/**
 * Voice status badge component displaying voice clone processing status.
 * Shows ready, processing, or failed states with estimated completion times.
 *
 * @param props - Voice status badge configuration
 * @param props.voice - Voice object with clone type and status
 */
"use client";

import { AlertCircle, CheckCircle2, Clock, Loader2 } from "lucide-react";
import { StatusBadge } from "../status-badge";

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
    return <StatusBadge status="success" label="Ready" icon={<CheckCircle2 />} />;
  }

  // Professional voice status
  if (voice.status === "failed") {
    return <StatusBadge status="error" label="Failed" icon={<AlertCircle />} />;
  }

  // Calculate time elapsed safely
  const createdAt = new Date(voice.createdAt);
  const now = new Date();
  const minutesElapsed = Math.max(0, (now.getTime() - createdAt.getTime()) / 1000 / 60);

  const minProcessingTime = 30; // 30 minutes minimum
  const maxProcessingTime = 60; // 60 minutes maximum

  if (minutesElapsed >= maxProcessingTime) {
    // Over 60 minutes - should be ready
    return <StatusBadge status="success" label="Ready" icon={<CheckCircle2 />} />;
  }

  if (minutesElapsed >= minProcessingTime) {
    // Between 30-60 minutes - finalizing
    return <StatusBadge status="warning" label="Finalizing" icon={<Clock />} />;
  }

  // Still processing (under 30 minutes)
  return <StatusBadge status="processing" label="Processing" icon={<Loader2 />} />;
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
  const minutesElapsed = Math.max(0, (now.getTime() - createdAt.getTime()) / 1000 / 60);

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
