/** Routes pseudo-URL agent requests through the native fingerprint-pinned SSH tunnel. */

import {
  type AgentRequestTransport,
  awaitBridgeRequest,
  headersToRecord,
  loadAgentProfileRegistry,
  nativeHttpResultToResponse,
  requestSshRuntime,
  requireTextRequestBody,
} from "@elizaos/ui";

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
      init.signal?.throwIfAborted();
      const currentProfile = profileForSshUrl(requestUrl);
      if (!currentProfile || currentProfile.id !== profile.id) {
        throw new TypeError(
          "SSH request does not match the transport runtime.",
        );
      }
      const parsed = new URL(requestUrl);
      const segments = parsed.pathname.split("/").filter(Boolean);
      const requestPath = `/${segments.slice(1).join("/")}${parsed.search}`;
      const rawBody = requireTextRequestBody(init.body);
      const method = (init.method ?? "GET").toUpperCase();
      if (!["GET", "POST", "PATCH", "DELETE"].includes(method)) {
        throw new Error(`The SSH runtime does not allow ${method} requests.`);
      }
      if (method === "GET" && rawBody != null) {
        throw new TypeError("GET requests must not carry a body.");
      }
      const result = await awaitBridgeRequest(
        () =>
          requestSshRuntime({
            runtimeId: profile.id,
            credentialRef: currentProfile.credentialRef,
            path: requestPath,
            method: method as "GET" | "POST" | "PATCH" | "DELETE",
            headers: headersToRecord(init.headers),
            body: rawBody ?? null,
            timeoutMs: context?.timeoutMs ?? 30_000,
          }),
        init.signal,
        context?.timeoutMs ?? 30_000,
      );
      return nativeHttpResultToResponse(result);
    },
  };
}
