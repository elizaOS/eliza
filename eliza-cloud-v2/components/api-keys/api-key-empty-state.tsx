/**
 * API key empty state component displayed when no API keys exist.
 * Provides call-to-action button to create first API key.
 *
 * @param props - API key empty state configuration
 * @param props.onCreateKey - Optional callback when create button is clicked
 */
import { KeyRound, Plus } from "lucide-react";

import { BrandButton } from "@/components/brand";

interface ApiKeyEmptyStateProps {
  onCreateKey?: () => void;
}

export function ApiKeyEmptyState({ onCreateKey }: ApiKeyEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-none border border-dashed border-white/10 bg-black/40 px-10 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#FF580020] border border-[#FF5800]/40">
        <KeyRound className="h-7 w-7 text-[#FF5800]" />
      </div>
      <h3 className="mt-6 text-2xl font-semibold text-white">
        No API keys yet
      </h3>
      <p className="mt-2 max-w-sm text-sm text-white/60">
        Create your first API key to start authenticating requests and tracking
        usage across the platform.
      </p>
      <BrandButton variant="primary" className="mt-6" onClick={onCreateKey}>
        <Plus className="mr-2 h-4 w-4" />
        Create API Key
      </BrandButton>
    </div>
  );
}
