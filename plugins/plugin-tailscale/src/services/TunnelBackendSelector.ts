import { isCloudConnected } from "@elizaos/cloud-routing";
import { elizaLogger, type IAgentRuntime } from "@elizaos/core";
import {
  readTailscaleAccounts,
  resolveTailscaleAccount,
  resolveTailscaleAccountId,
} from "../accounts";
import type { TailscaleBackendMode } from "../types";
import { CloudTailscaleService } from "./CloudTailscaleService";
import { LocalTailscaleService } from "./LocalTailscaleService";

export type TunnelBackendCtor =
  | typeof LocalTailscaleService
  | typeof CloudTailscaleService;

export interface BackendDecision {
  backend: TunnelBackendCtor;
  mode: TailscaleBackendMode;
  reason: string;
}

const ALLOWED_MODES: ReadonlySet<TailscaleBackendMode> = new Set([
  "local",
  "cloud",
  "auto",
]);

export function readBackendMode(runtime: IAgentRuntime): TailscaleBackendMode {
  const account = resolveTailscaleAccount(
    readTailscaleAccounts(runtime),
    resolveTailscaleAccountId(runtime),
  );
  const raw = account?.backend ?? runtime.getSetting("TAILSCALE_BACKEND");
  if (raw === null || raw === undefined) return "auto";
  const normalized = String(raw).trim().toLowerCase();
  if (ALLOWED_MODES.has(normalized as TailscaleBackendMode)) {
    return normalized as TailscaleBackendMode;
  }
  elizaLogger.warn(
    `[TunnelBackendSelector] invalid TAILSCALE_BACKEND="${raw}" — falling back to "auto"`,
  );
  return "auto";
}

export function selectTunnelBackend(runtime: IAgentRuntime): BackendDecision {
  const mode = readBackendMode(runtime);

  switch (mode) {
    case "local":
      return {
        backend: LocalTailscaleService,
        mode,
        reason: "TAILSCALE_BACKEND=local",
      };
    case "cloud":
      return {
        backend: CloudTailscaleService,
        mode,
        reason: "TAILSCALE_BACKEND=cloud",
      };
    case "auto": {
      if (isCloudConnected(runtime)) {
        return {
          backend: CloudTailscaleService,
          mode,
          reason: "auto: cloud connected",
        };
      }
      return {
        backend: LocalTailscaleService,
        mode,
        reason: "auto: cloud not connected",
      };
    }
  }
}
