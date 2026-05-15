/**
 * API key empty state using the shared EmptyState component.
 */
import { KeyRound, Plus } from "lucide-react";
import { BrandButton } from "./brand/brand-button";
import { EmptyState } from "./empty-state";

interface ApiKeyEmptyStateProps {
  onCreateKey?: () => void;
}

export function ApiKeyEmptyState({ onCreateKey }: ApiKeyEmptyStateProps) {
  return (
    <EmptyState
      icon={<KeyRound className="h-7 w-7 text-[#FF5800]" />}
      title="No API keys yet"
      description="Create your first API key to start authenticating requests and tracking usage across the platform."
      action={
        <BrandButton variant="primary" onClick={onCreateKey}>
          <Plus className="mr-2 h-4 w-4" />
          Create API Key
        </BrandButton>
      }
    />
  );
}
