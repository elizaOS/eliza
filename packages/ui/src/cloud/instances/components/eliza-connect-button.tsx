"use client";

/**
 * Button that opens/connects to a cloud agent instance (external link into the
 * running agent).
 */
import { BrandButton } from "@elizaos/ui/cloud-ui";
import { ExternalLink } from "lucide-react";
import { useT } from "../lib/i18n";
import { openWebUIWithPairing } from "../lib/open-web-ui";

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
