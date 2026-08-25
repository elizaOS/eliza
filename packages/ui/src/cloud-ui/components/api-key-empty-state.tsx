/**
 * API key empty state using the shared EmptyState component.
 */
import { KeyRound, Plus } from "lucide-react";
import { EmptyState } from "../../components/ui/empty-state";
import { BrandButton } from "./brand/brand-button";

interface ApiKeyEmptyStateProps {
  onCreateKey?: () => void;
}

export function ApiKeyEmptyState({ onCreateKey }: ApiKeyEmptyStateProps) {
  return (
    <EmptyState
      icon={<KeyRound className="size-7 text-muted" />}
      title="No API keys yet"
      description="Create your first API key to start authenticating requests and tracking usage across the platform."
      action={
        <BrandButton variant="primary" onClick={onCreateKey}>
          <Plus className="mr-2  size-4" />
          Create API Key
        </BrandButton>
      }
    />
  );
}
