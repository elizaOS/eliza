/**
 * Empty state for voice studio using the shared EmptyState component.
 */
"use client";

import { Mic } from "lucide-react";
import { Button } from "../button";
import { EmptyState } from "../empty-state";

interface VoiceEmptyStateProps {
  onCreateClick: () => void;
}

export function VoiceEmptyState({ onCreateClick }: VoiceEmptyStateProps) {
  return (
    <EmptyState
      icon={<Mic className="h-7 w-7 text-[#FF5800]" />}
      title="Create a Voice Clone"
      action={
        <Button onClick={onCreateClick} size="lg" className="h-12 px-8">
          <Mic className="mr-2 h-5 w-5" />
          Get Started
        </Button>
      }
    >
      <p className="text-xs text-muted-foreground">
        Instant: 50 credits • Professional: 200 credits
      </p>
    </EmptyState>
  );
}
