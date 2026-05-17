import type http from "node:http";
import { resolveWalletExportRejection as upstreamResolveWalletExportRejection } from "@elizaos/agent";
import type { WalletExportRejection as CompatWalletExportRejection } from "@elizaos/shared";
export declare function normalizeCompatRejection<
  T extends {
    status: number;
    reason: string;
  } | null,
>(rejection: T): T;
export declare function runWithCompatAuthContext<T>(
  req: Pick<http.IncomingMessage, "headers">,
  operation: () => T,
): T;
export declare function resolveWalletExportRejection(
  ...args: Parameters<typeof upstreamResolveWalletExportRejection>
): CompatWalletExportRejection | null;
//# sourceMappingURL=server-wallet-trade.d.ts.map
