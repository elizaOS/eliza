/**
 * Website-blocker native backend registry — browser-safe module.
 *
 * The hosts-file engine (`./engine.ts`) is server-only: it imports
 * `node:child_process`, `node:fs`, `node:dns`, … and can never load in the
 * mobile WebView realm. The native-backend registry, however, MUST load
 * there — `packages/app/src/main.tsx` registers the Capacitor adapters
 * (Safari content blocker on iOS, split-tunnel VPN DNS on Android) at
 * renderer startup via `@elizaos/plugin-blocker/native`. Keeping the registry
 * in its own dependency-free module lets both realms share it:
 *
 * - server realm: `engine.ts` imports this module, so a backend registered in
 *   a bun-process engine consumer is the one the engine dispatches to.
 * - WebView realm: `../../native.ts` re-exports the registrars without
 *   dragging any `node:*` import into the renderer bundle.
 *
 * The backend contract types live in `engine.ts`; importing them `type`-only
 * keeps this module free of runtime edges into the server-only engine.
 */

import type {
  SelfControlBlockRequest,
  SelfControlPermissionState,
  SelfControlStatus,
} from "./engine.ts";

export interface NativeWebsiteBlockerBackend {
  getStatus(): Promise<SelfControlStatus>;
  startBlock(
    request: SelfControlBlockRequest,
  ): Promise<
    | { success: true; endsAt: string | null }
    | { success: false; error: string; status?: SelfControlStatus }
  >;
  stopBlock(): Promise<
    | { success: true; removed: boolean; status: SelfControlStatus }
    | { success: false; error: string; status?: SelfControlStatus }
  >;
  getPermissionState(): Promise<SelfControlPermissionState>;
  requestPermission(): Promise<SelfControlPermissionState>;
}

let nativeBackend: NativeWebsiteBlockerBackend | null = null;

export function registerNativeWebsiteBlockerBackend(
  backend: NativeWebsiteBlockerBackend,
): void {
  nativeBackend = backend;
}

export function getNativeWebsiteBlockerBackend(): NativeWebsiteBlockerBackend | null {
  return nativeBackend;
}
