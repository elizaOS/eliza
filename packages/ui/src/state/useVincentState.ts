import type {
  VincentStateHookArgs,
  VincentStateHookResult,
} from "../config/boot-config";
import { getBootConfig } from "../config/boot-config";

const DEFAULT_VINCENT_STATE: VincentStateHookResult = {
  vincentConnected: false,
  vincentLoginBusy: false,
  vincentLoginError: null,
  vincentConnectedAt: null,
  handleVincentLogin: async () => {},
  handleVincentDisconnect: async () => {},
  pollVincentStatus: async () => false,
};

export function useVincentState(
  args: VincentStateHookArgs,
): VincentStateHookResult {
  return getBootConfig().useVincentState?.(args) ?? DEFAULT_VINCENT_STATE;
}
