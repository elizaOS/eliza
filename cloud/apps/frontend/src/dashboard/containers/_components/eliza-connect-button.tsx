"use client";

import { BrandButton } from "@elizaos/cloud-ui";
import { ExternalLink } from "lucide-react";
import { openWebUIWithPairing } from "@/lib/hooks/open-web-ui";

interface Props {
  agentId: string;
}

export function ElizaConnectButton({ agentId }: Props) {
  return (
    <BrandButton variant="primary" size="sm" onClick={() => openWebUIWithPairing(agentId)}>
      <ExternalLink className="h-3.5 w-3.5" />
      Open Web UI
    </BrandButton>
  );
}
