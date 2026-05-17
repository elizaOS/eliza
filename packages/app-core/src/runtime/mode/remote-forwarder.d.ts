/**
 * Remote-mode forwarder.
 *
 * AGENTS.md §1: in `remote` mode, mutating cloud settings must affect the
 * *target's* cloud settings (the local instance the controller is wired
 * to), not the controller's own config. The controller has no cloud
 * surface of its own — every cloud-routed write proxies to the target.
 *
 * Reads stay local: the dashboard reads its own status (which is the
 * thin-client target shape), and queries that need target state already
 * route through `/api/cloud/v1/*` (the cloud thin-client proxy).
 *
 * This module does not catch transport errors — a broken target is a
 * 502 surface to the caller, not a silent log-and-continue.
 */
import type http from "node:http";
export declare function shouldForwardToRemoteTarget(pathname: string, method: string): boolean;
/**
 * Build the outbound `Headers` for the target. Visible for testing.
 *
 * Per RFC 7230 §3.2.2, multi-valued request headers (`Cookie`, `Accept`,
 * `Forwarded`, etc.) are equivalent to a single comma-joined value.
 * Node parses `set-cookie` and any duplicated header as `string[]`;
 * we forward every value via `headers.append(name, v)` instead of
 * silently dropping the array (the previous behavior).
 */
export declare function buildForwardHeaders(incoming: http.IncomingHttpHeaders, targetHost: string, remoteAccessToken: string | null): Headers;
/**
 * Returns true when the controller forwarded the request to the target
 * (and wrote the response). Returns false when not in remote mode or the
 * route is not in the forwarded list, in which case the caller continues
 * dispatch.
 */
export declare function forwardRemoteCloudMutation(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean>;
//# sourceMappingURL=remote-forwarder.d.ts.map