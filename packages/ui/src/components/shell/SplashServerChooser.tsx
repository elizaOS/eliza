import { Button, Card, CardContent } from "@elizaos/ui";
import type { GatewayDiscoveryEndpoint } from "../../bridge/gateway-discovery";

const MONO_FONT = "'Courier New', 'Courier', 'Monaco', monospace";

interface SplashServerChooserProps {
  discoveryLoading: boolean;
  gateways: GatewayDiscoveryEndpoint[];
  showCreateLocal: boolean;
  t: (key: string, values?: Record<string, unknown>) => string;
  onCreateLocal: () => void;
  onManualConnect: () => void;
  onManageCloudAgents: () => void;
  onConnectGateway: (gateway: GatewayDiscoveryEndpoint) => void;
}

function gatewayLabel(
  gateway: GatewayDiscoveryEndpoint,
  t: SplashServerChooserProps["t"],
): string {
  return gateway.isLocal
    ? t("startupshell.LocalNetworkAgent", { defaultValue: "LAN agent" })
    : t("startupshell.NetworkAgent", { defaultValue: "Network agent" });
}

export function SplashServerChooser({
  gateways,
  showCreateLocal,
  t,
  onCreateLocal,
  onManualConnect,
  onManageCloudAgents,
  onConnectGateway,
}: SplashServerChooserProps) {
  return (
    <div className="mt-4 flex w-full flex-col gap-3 text-left">
      {gateways.length > 0 && (
        <div className="flex flex-col gap-2">
          {gateways.map((gateway) => (
            <Card
              key={gateway.stableId}
              className="border-2 border-black bg-white shadow-md"
            >
              <CardContent className="flex items-center justify-between gap-3 px-3 py-3">
                <div className="min-w-0">
                  <p
                    style={{ fontFamily: MONO_FONT }}
                    className="text-3xs uppercase text-black/60"
                  >
                    {gatewayLabel(gateway, t)}
                  </p>
                  <p className="truncate text-sm font-semibold text-black">
                    {gateway.name}
                  </p>
                  <p className="truncate text-xs-tight text-black/70">
                    {gateway.host}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0 border-2 border-black bg-white text-black font-semibold hover:bg-black hover:text-[#ffe600]"
                  onClick={() => onConnectGateway(gateway)}
                >
                  {t("common.connect", { defaultValue: "Connect" })}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {showCreateLocal ? (
        <Button
          type="button"
          variant="default"
          className="justify-start border-2 border-black bg-black px-3 py-5 text-left text-[#ffe600] font-semibold shadow-md hover:bg-[#ffe600] hover:text-black hover:border-black"
          onClick={onCreateLocal}
        >
          <span className="flex flex-col items-start gap-1">
            <span
              style={{ fontFamily: MONO_FONT }}
              className="text-3xs uppercase text-[#ffe600]/80"
            >
              {t("startupshell.CreateAgentLabel", {
                defaultValue: "Desktop only",
              })}
            </span>
            <span className="text-sm font-bold">
              {t("startupshell.CreateLocalAgent", {
                defaultValue: "Create Local Agent",
              })}
            </span>
          </span>
        </Button>
      ) : null}

      <Button
        type="button"
        variant="default"
        className="justify-start border-2 border-black bg-white px-3 py-5 text-left text-black font-semibold shadow-md hover:bg-black hover:text-[#ffe600]"
        onClick={onManageCloudAgents}
      >
        <span className="flex flex-col items-start gap-1">
          <span
            style={{ fontFamily: MONO_FONT }}
            className="text-3xs uppercase text-black/60"
          >
            {t("common.elizaCloud", {
              defaultValue: "Eliza Cloud",
            })}
          </span>
          <span className="text-sm font-bold">
            {t("startupshell.ManageCloudAgents", {
              defaultValue: "Manage Cloud Agents",
            })}
          </span>
        </span>
      </Button>

      <Button
        type="button"
        variant="default"
        className="justify-start border-2 border-black bg-white px-3 py-5 text-left text-black font-semibold shadow-md hover:bg-black hover:text-[#ffe600]"
        onClick={onManualConnect}
      >
        <span className="flex flex-col items-start gap-1">
          <span
            style={{ fontFamily: MONO_FONT }}
            className="text-3xs uppercase text-black/60"
          >
            {t("startupshell.RemoteAgentLabel", {
              defaultValue: "Remote server",
            })}
          </span>
          <span className="text-sm font-bold">
            {t("startupshell.ConnectToRemote", {
              defaultValue: "Connect to Remote Agent",
            })}
          </span>
        </span>
      </Button>
    </div>
  );
}
