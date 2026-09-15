"use client";

/**
 * Button that opens/connects to a cloud agent instance (external link into the
 * running agent).
 */
import { Button } from "@elizaos/ui/cloud-ui";
import { ExternalLink } from "lucide-react";
import { useT } from "../lib/i18n";
import { openWebUIWithPairing } from "../lib/open-web-ui";

interface Props {
  agentId: string;
}

export function ElizaConnectButton({ agentId }: Props) {
  const t = useT();
  return (
    <Button
      variant="default"
      size="sm"
      className="min-h-touch"
      onClick={() => openWebUIWithPairing(agentId)}
    >
      <ExternalLink className="size-3.5" />
      {t("cloud.containers.connect.openWebUi", { defaultValue: "Open Web UI" })}
    </Button>
  );
}
