"use client";

import { BrandButton } from "@elizaos/ui";
import { ExternalLink } from "lucide-react";
import { openWebUIWithPairing } from "@/lib/hooks/open-web-ui";
import { useT } from "@/providers/I18nProvider";

interface Props {
  agentId: string;
}

export function ElizaConnectButton({ agentId }: Props) {
  const t = useT();
  return (
    <BrandButton
      variant="primary"
      size="sm"
      onClick={() => openWebUIWithPairing(agentId)}
    >
      <ExternalLink className="h-3.5 w-3.5" />
      {t("cloud.containers.connect.openWebUi", { defaultValue: "Open Web UI" })}
    </BrandButton>
  );
}
