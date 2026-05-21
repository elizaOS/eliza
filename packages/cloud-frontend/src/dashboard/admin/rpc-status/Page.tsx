/** /dashboard/admin/rpc-status — verify the worker can reach each chain's RPC. */

import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@elizaos/ui";
import { useQuery } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { Helmet } from "react-helmet-async";
import { api } from "../../../lib/api-client";

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

export default function AdminRpcStatusPage() {
  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["admin", "rpc-status"],
    queryFn: () => api<RpcStatusResponse>("/admin/rpc-status"),
    staleTime: 30_000,
  });

  const payload = data?.data;

  return (
    <>
      <Helmet>
        <title>Admin: RPC Status</title>
      </Helmet>
      <div className="space-y-4 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">RPC Status</h1>
            <p className="text-sm text-muted-foreground">
              Live probe of each chain's RPC + ELIZA token balance on the
              treasury hot wallet.
            </p>
          </div>
          <Button onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            <span className="ml-2">Refresh</span>
          </Button>
        </div>

        {error && (
          <Card className="border-destructive">
            <CardContent className="p-4 text-destructive">
              {error instanceof Error ? error.message : "Failed to load RPC status"}
            </CardContent>
          </Card>
        )}

        {isLoading && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Probing RPCs…
          </div>
        )}

        {payload && (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  Treasury hot wallet
                  <Badge variant={payload.hotWalletAddress ? "default" : "destructive"}>
                    {payload.hotWalletAddress ? "configured" : "missing"}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="font-mono text-xs">
                EVM: {payload.hotWalletAddress ?? "—"}
                <br />
                Solana RPC: {payload.solana.rpcUrl} (
                {payload.solana.configured ? "key configured" : "no key"})
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {payload.evm.map((p) => (
                <Card key={p.network} className={p.reachable ? "" : "border-destructive"}>
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
                      <div className="break-all text-destructive">error: {p.error}</div>
                    )}
                    {p.rpcSource === "public_default" && (
                      <div className="text-amber-500">
                        Using chain's public RPC — set a dedicated provider URL for
                        production.
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>

            <p className="text-xs text-muted-foreground">
              Checked at {new Date(payload.checkedAt).toLocaleString()}
            </p>
          </>
        )}
      </div>
    </>
  );
}
