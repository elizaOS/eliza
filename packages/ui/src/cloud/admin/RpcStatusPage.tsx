/**
 * /dashboard/admin/rpc-status — verify the worker can reach each chain's RPC.
 * The route-level {@link AdminGate} owns the role gate and page chrome.
 */

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@elizaos/ui/cloud-ui";
import { useQuery } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { api } from "../lib/api-client";
import { useDocumentTitle } from "../lib/use-document-title";
import { useCloudT } from "../shell/CloudI18nProvider";

interface RpcProbe {
  network: "ethereum" | "base" | "bnb";
  chainId: number;
  rpcUrl: string;
  rpcSource: string;
  reachable: boolean;
  latencyMs: number | null;
  latestBlock: string | null;
  hotWalletAddress: string | null;
  hotWalletBalance: number | null;
  error: string | null;
}

interface RpcStatusResponse {
  success: boolean;
  data: {
    evm: RpcProbe[];
    solana: { rpcUrl: string; configured: boolean };
    allReachable: boolean;
    hotWalletAddress: string | null;
    checkedAt: string;
  };
}

export default function RpcStatusPage(): React.JSX.Element {
  const t = useCloudT();
  useDocumentTitle(
    t("cloud.admin.rpcStatus.metaTitle", {
      defaultValue: "Admin: RPC Status · Eliza Cloud",
    }),
  );

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["admin", "rpc-status"],
    queryFn: () => api<RpcStatusResponse>("/admin/rpc-status"),
    staleTime: 30_000,
  });

  const payload = data?.data;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">
            {t("cloud.admin.rpcStatus.title", { defaultValue: "RPC Status" })}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("cloud.admin.rpcStatus.subtitle", {
              defaultValue:
                "Live probe of each chain's RPC + ELIZA token balance on the treasury hot wallet.",
            })}
          </p>
        </div>
        <Button onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          <span className="ml-2">
            {t("cloud.admin.rpcStatus.refresh", { defaultValue: "Refresh" })}
          </span>
        </Button>
      </div>

      {error && (
        <Card className="border-destructive">
          <CardContent className="p-4 text-destructive">
            {error instanceof Error
              ? error.message
              : t("cloud.admin.rpcStatus.loadFailed", {
                  defaultValue: "Failed to load RPC status",
                })}
          </CardContent>
        </Card>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("cloud.admin.rpcStatus.probing", {
            defaultValue: "Probing RPCs…",
          })}
        </div>
      )}

      {payload && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {t("cloud.admin.rpcStatus.treasuryWallet", {
                  defaultValue: "Treasury hot wallet",
                })}
                <Badge
                  variant={payload.hotWalletAddress ? "default" : "destructive"}
                >
                  {payload.hotWalletAddress
                    ? t("cloud.admin.rpcStatus.configured", {
                        defaultValue: "configured",
                      })
                    : t("cloud.admin.rpcStatus.missing", {
                        defaultValue: "missing",
                      })}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="font-mono text-xs">
              EVM: {payload.hotWalletAddress ?? "—"}
              <br />
              Solana RPC: {payload.solana.rpcUrl} (
              {payload.solana.configured
                ? t("cloud.admin.rpcStatus.keyConfigured", {
                    defaultValue: "key configured",
                  })
                : t("cloud.admin.rpcStatus.noKey", { defaultValue: "no key" })}
              )
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {payload.evm.map((p) => (
              <Card
                key={p.network}
                className={p.reachable ? "" : "border-destructive"}
              >
                <CardHeader>
                  <CardTitle className="flex items-center justify-between text-base">
                    <span className="capitalize">{p.network}</span>
                    <Badge variant={p.reachable ? "default" : "destructive"}>
                      {p.reachable ? "OK" : "FAIL"}
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-xs">
                  <div>chainId: {p.chainId}</div>
                  <div>source: {p.rpcSource}</div>
                  <div className="break-all">url: {p.rpcUrl}</div>
                  <div>latency: {p.latencyMs ?? "—"} ms</div>
                  <div>latest block: {p.latestBlock ?? "—"}</div>
                  <div>
                    ELIZA balance: {p.hotWalletBalance?.toLocaleString() ?? "—"}
                  </div>
                  {p.error && (
                    <div className="break-all text-destructive">
                      error: {p.error}
                    </div>
                  )}
                  {p.rpcSource === "public_default" && (
                    <div className="text-warn">
                      {t("cloud.admin.rpcStatus.publicRpcWarning", {
                        defaultValue:
                          "Using chain's public RPC — set a dedicated provider URL for production.",
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>

          <p className="text-xs text-muted-foreground">
            {t("cloud.admin.rpcStatus.checkedAt", {
              defaultValue: "Checked at",
            })}{" "}
            {new Date(payload.checkedAt).toLocaleString()}
          </p>
        </>
      )}
    </div>
  );
}
