/**
 * Wire and browser-storage contracts for handing a Cloud agent session from
 * the pairing exchange into the app boot path.
 */

export const CLOUD_PAIR_LEGACY_STORAGE_KEY = "eliza:cloud-pair:api-token";
export const CLOUD_PAIR_SCOPED_STORAGE_PREFIX = `${CLOUD_PAIR_LEGACY_STORAGE_KEY}:`;

const CLOUD_AGENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CloudPairExchangeResponse {
  message: string;
  apiKey: string;
  agentName: string;
  agentId: string;
}

export interface CloudPairRelaySession {
  apiKey: string;
  agentId: string;
  agentName?: string;
}

/** The dedicated-agent identity format accepted at every pairing boundary. */
export function isCloudPairAgentId(value: unknown): value is string {
  return typeof value === "string" && CLOUD_AGENT_ID_PATTERN.test(value);
}

/**
 * Per-agent storage key for a durable Cloud-pair credential. The caller owns
 * identity validation because browser migration tests also exercise historic
 * non-UUID identifiers through this stable key-builder contract.
 */
export function cloudPairTokenKeyForAgent(agentId: string): string {
  return `${CLOUD_PAIR_SCOPED_STORAGE_PREFIX}${agentId}`;
}

/** Resolve the platform-owned agent identity injected into a local relay. */
export function resolveCloudPairAgentIdFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const candidate =
    env.ELIZA_CLOUD_AGENT_ID?.trim() ||
    env.WAIFU_ELIZA_CLOUD_AGENT_ID?.trim() ||
    "";
  return isCloudPairAgentId(candidate) ? candidate : null;
}

/**
 * Render the executable browser handoff shared by Cloud edge and local relay
 * boundaries. JSON string encoding plus the explicit `<` escape keeps opaque
 * bearer bytes inert inside the script element.
 */
export function renderCloudPairHandoffHtml(
  apiKey: string,
  agentId: string,
): string {
  const safeKey = JSON.stringify(apiKey).replace(/</g, "\\u003c");
  const safeStorageKey = JSON.stringify(
    cloudPairTokenKeyForAgent(agentId),
  ).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <title>Signing in...</title>
  <style>
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif;background:#0a0a0a;color:#e5e5e5}
    p{margin:0;font-size:.9rem;opacity:.8}
  </style>
</head>
<body>
  <p>Signing in to your agent...</p>
  <script>
    (function () {
      try {
        var key = ${safeKey};
        var storageKey = ${safeStorageKey};
        function persist(storage) {
          try {
            storage.setItem(storageKey, key);
            return true;
          } catch (_storageError) {
            return false;
          }
        }
        var storedInSession = persist(window.sessionStorage);
        var storedDurably = persist(window.localStorage);
        if (!(storedInSession || storedDurably)) {
          throw new Error("No browser storage accepted the paired token.");
        }
        var slot = Symbol.for("elizaos.app.boot-config");
        var previous = window.__ELIZAOS_APP_BOOT_CONFIG__ ||
          window.__ELIZA_APP_BOOT_CONFIG__ ||
          (window[slot] && window[slot].current) ||
          {};
        var next = Object.assign({}, previous, { apiToken: key });
        window.__ELIZAOS_APP_BOOT_CONFIG__ = next;
        window.__ELIZA_APP_BOOT_CONFIG__ = next;
        window[slot] = { current: next };
      } catch (error) {
        console.error("[cloud-pair] failed to persist the paired token", error);
        var paragraph = document.querySelector("p");
        if (paragraph) paragraph.textContent = "Pairing failed. Close this window and try signing in again.";
        return;
      }
      window.location.replace("/");
    })();
  </script>
</body>
</html>`;
}

/** Validate the successful dependency payload before a relay writes a bearer. */
export function parseCloudPairRelaySession(
  value: unknown,
): CloudPairRelaySession | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.apiKey !== "string" ||
    !record.apiKey.trim() ||
    !isCloudPairAgentId(record.agentId)
  ) {
    return null;
  }

  return {
    apiKey: record.apiKey,
    agentId: record.agentId,
    ...(typeof record.agentName === "string"
      ? { agentName: record.agentName }
      : {}),
  };
}
