/** A bounded readiness probe with diagnostics safe to include in dev logs. */
export async function probeApiHealth(
  port,
  { fetchImpl = fetch, timeoutMs = 1500, now = () => performance.now() } = {},
) {
  const startedAt = now();
  const signal = AbortSignal.timeout(timeoutMs);
  let status = null;
  const result = (healthy, reason) => ({
    healthy,
    reason,
    status,
    elapsedMs: Math.max(0, Math.round(now() - startedAt)),
  });

  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/health`, {
      signal,
    });
    status = response.status;
    if (!response.ok) return result(false, "http_error");
    let body;
    try {
      body = await response.json();
    } catch {
      // error-policy:J4 distinguish a stalled response body from malformed
      // JSON without copying either response content or parser error text.
      return result(false, signal.aborted ? "timeout" : "invalid_json");
    }
    return result(
      body?.ready === true,
      body?.ready === true ? "ready" : "not_ready",
    );
  } catch {
    // error-policy:J4 the supervisor decides restart policy; this boundary
    // preserves why a probe failed without disclosing network error text.
    return result(false, signal.aborted ? "timeout" : "transport_error");
  }
}
