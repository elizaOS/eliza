/** Routes pseudo-URL agent requests through the native fingerprint-pinned SSH tunnel. */
import { requestSshRuntime } from "../platform/ssh-runtime";
import { loadAgentProfileRegistry } from "../state/agent-profiles";
import type { AgentRequestTransport } from "./transport";
import { bodyToString, headersToRecord } from "./transport";

function profileForSshUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // error-policy:J3 pseudo-URLs are untrusted transport input.
    return null;
  }
  if (parsed.protocol !== "eliza-ssh:" || parsed.hostname !== "runtime") {
    return null;
  }
  const runtimeId = parsed.pathname.split("/").filter(Boolean)[0];
  if (!runtimeId) return null;
  return (
    loadAgentProfileRegistry().profiles.find(
      (profile) => profile.id === runtimeId && profile.connectionMode === "ssh",
    ) ?? null
  );
}

export function sshRuntimeTransportForUrl(
  url: string,
): AgentRequestTransport | null {
  const profile = profileForSshUrl(url);
  if (!profile) return null;
  return {
    async request(requestUrl, init, context) {
      const parsed = new URL(requestUrl);
      const segments = parsed.pathname.split("/").filter(Boolean);
      const requestPath = `/${segments.slice(1).join("/")}${parsed.search}`;
      const rawBody = bodyToString(init.body);
      if (rawBody === undefined && init.body !== undefined) {
        throw new Error("The SSH runtime supports text request bodies only.");
      }
      const method = (init.method ?? "GET").toUpperCase();
      if (!["GET", "POST", "PATCH", "DELETE"].includes(method)) {
        throw new Error(`The SSH runtime does not allow ${method} requests.`);
      }
      const result = await requestSshRuntime({
        runtimeId: profile.id,
        credentialRef: profile.credentialRef,
        path: requestPath,
        method: method as "GET" | "POST" | "PATCH" | "DELETE",
        headers: headersToRecord(init.headers),
        body: rawBody ?? null,
        timeoutMs: context?.timeoutMs ?? 30_000,
      });
      return new Response(result.body, {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
      });
    },
  };
}
