/**
 * Empty state component for voice studio when no voices exist.
 * Displays call-to-action to create first voice clone with pricing information.
 *
 * @param props - Voice empty state configuration
 * @param props.onCreateClick - Callback when create button is clicked
 */

"use client";

import { Mic } from "lucide-react";
import { Button } from "@/components/ui/button";

interface VoiceEmptyStateProps {
  onCreateClick: () => void;
}

export function VoiceEmptyState({ onCreateClick }: VoiceEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div className="rounded-full bg-primary/10 p-6 mb-6">
        <Mic className="h-12 w-12 text-primary" />
      </div>

      <h2 className="text-2xl font-bold mb-6">Create a Voice Clone</h2>

      <Button onClick={onCreateClick} size="lg" className="h-12 px-8">
        <Mic className="mr-2 h-5 w-5" />
        Get Started
      </Button>

      <p className="text-xs text-muted-foreground mt-4">
        Instant: 50 credits • Professional: 200 credits
      </p>
    </div>
  );
}
