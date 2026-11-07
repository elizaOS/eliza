import { getBootConfig as getBootConfigForNativeUpdate } from "../config/boot-config-store";
import { ElizaClient as _ElizaClient, type ElizaClient } from "./client-base";

export { ElizaClient } from "./client-base";

// ---------------------------------------------------------------------------
// Domain method augmentations (declaration merging + prototype assignment)
// These import ElizaClient from client-base directly, avoiding circular deps.
// ---------------------------------------------------------------------------
import "./client-agent";
import "./client-accounts";
import "./client-approvals";
import "./client-automations";
import "./client-background";
import "./client-browser-workspace";
import "./client-chat";
import "./client-cloud";
import "./client-computeruse";
import "./client-files";
import "./client-imessage";
import "./client-local-inference";
import "./client-meetings";
import "./client-notifications";
import "./client-scheduled-tasks";
import "./client-voice-models";
import "./client-workflow";
import "./client-skills";
import "./client-transcripts";
import "./client-vault";
import "./client-wallet";
// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------
// External plugins augment ElizaClient via `declare module "@elizaos/ui"`.
// Annotating with ElizaClient (which TypeScript normalizes to the canonical
// @elizaos/ui export) makes augmented methods visible to callers. The
// prototype has all methods at runtime via the augmenting side-effect imports.
export const client: ElizaClient = new _ElizaClient();
if (typeof window !== "undefined") {
  window.addEventListener("eliza:desktop-api-base-updated", (event: Event) => {
    const detail = (
      event as CustomEvent<{
        previousBase: string | null;
        base: string;
      }>
    ).detail;
    if (!detail || typeof detail.base !== "string") return;
    const current = client.getBaseUrl().replace(/\/+$/, "");
    if (
      current !== detail.previousBase &&
      current !== detail.base &&
      current !== ""
    )
      return;
    const config = getBootConfigForNativeUpdate();
    const nativeWindow = window as typeof window & {
      __ELIZA_DESKTOP_LOCAL_API_BASE__?: string;
      __ELIZA_DESKTOP_EXTERNAL_API_BASE__?: string;
    };
    const binding =
      nativeWindow.__ELIZA_DESKTOP_LOCAL_API_BASE__ ??
      nativeWindow.__ELIZA_DESKTOP_EXTERNAL_API_BASE__;
    if (binding !== detail.base || config.apiBase !== detail.base) return;
    const token = config.apiToken?.trim() || null;
    // Native publication already excludes unchanged base/token pairs. Lazy
    // getters can show the new config while the old WebSocket is still open.
    client.repointBaseUrl(detail.base, token);
  });
}
