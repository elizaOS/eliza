/**
 * Voice page client component wrapping voice studio with page header.
 * Manages credit balance state and passes it to voice studio.
 *
 * @param props - Voice page client configuration
 * @param props.initialVoices - Initial list of voices
 * @param props.creditBalance - Initial credit balance
 */

"use client";

import { useSetPageHeader } from "@elizaos/cloud-ui";
import { useState } from "react";
import type { Voice } from "@elizaos/cloud-ui/components/voice/types";
import { VoiceStudioAdvanced } from "./voice-studio-advanced";

interface VoicePageClientProps {
  initialVoices: Voice[];
  creditBalance: number;
}

export function VoicePageClient({
  initialVoices,
  creditBalance: initialCreditBalance,
}: VoicePageClientProps) {
  const [creditBalance, setCreditBalance] = useState(initialCreditBalance);

  useSetPageHeader({
    title: "Voice Studio",
    description: "Clone your voice and create custom AI voices",
  });

  return (
    <div className="flex flex-col w-full">
      <div className="w-full max-w-[1600px] mx-auto px-3 md:px-6 py-4 md:py-6">
        <VoiceStudioAdvanced
          initialVoices={initialVoices}
          creditBalance={creditBalance}
          onCreditBalanceChange={setCreditBalance}
        />
      </div>
    </div>
  );
}
