/** JSON-RPC requests retain a deadline through response consumption. */
export function rpcJsonRequest(timeoutMs: number, body: string): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body,
  };
}
