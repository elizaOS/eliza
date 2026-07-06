/**
 * Credential probe engine: executes a connection's declarative `verify` spec
 * against saved values and reports pass/fail with the upstream status line.
 *
 * Probes are read-only by design (models lists, whoami endpoints, token
 * refreshes) so verifying never mutates a connected account; the one paid
 * exception (Tavily search) burns a single credit. Private keys use
 * `kind: "format"` — they must never leave the machine. Network failures are
 * reported as `error` (distinct from `invalid`) so the operator can tell "bad
 * key" from "no internet".
 */

import net from "node:net";

function substitute(template, values) {
  return template.replace(
    /\{\{([A-Z0-9_]+)\}\}/g,
    (_, key) => values[key] ?? "",
  );
}

async function httpProbe(spec, values) {
  const url = substitute(spec.url, values);
  const headers = {};
  for (const [name, template] of Object.entries(spec.headers ?? {})) {
    headers[name] = substitute(template, values);
  }
  if (spec.basicAuth) {
    const [user, pass] = spec.basicAuth.map((t) => substitute(t, values));
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      method: spec.method ?? "GET",
      headers,
      body: spec.body ? substitute(spec.body, values) : undefined,
      signal: controller.signal,
    });
    const bodyText = await response.text();
    const okStatus = response.status >= 200 && response.status < 300;
    const okBody = spec.okBodyPattern
      ? new RegExp(spec.okBodyPattern).test(bodyText)
      : true;
    if (okStatus && okBody) {
      return { ok: true, status: "valid", detail: `HTTP ${response.status}` };
    }
    return {
      ok: false,
      status: "invalid",
      detail: `HTTP ${response.status}: ${bodyText.slice(0, 300)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function tcpProbe(spec, values) {
  const raw = values[spec.urlVar] ?? "";
  let host;
  let port;
  try {
    const url = new URL(raw);
    host = url.hostname;
    port = Number(url.port || 5432);
  } catch {
    return Promise.resolve({
      ok: false,
      status: "invalid",
      detail: `${spec.urlVar} is not a parseable URL`,
    });
  }
  return new Promise((resolvePromise) => {
    const socket = net.connect({ host, port, timeout: 5_000 });
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise({
        ok: true,
        status: "valid",
        detail: `TCP ${host}:${port} reachable (auth checked by suites)`,
      });
    });
    const fail = (why) => () => {
      socket.destroy();
      resolvePromise({
        ok: false,
        status: "invalid",
        detail: `${host}:${port} ${why}`,
      });
    };
    socket.once("timeout", fail("timed out"));
    socket.once("error", fail("refused/unreachable"));
  });
}

/** Returns { ok, status: valid|invalid|error|unchecked, detail }. */
export async function verifyConnection(connection, values) {
  const spec = connection.verify ?? { kind: "none" };
  try {
    if (spec.kind === "http") return await httpProbe(spec, values);
    if (spec.kind === "tcp") return await tcpProbe(spec, values);
    if (spec.kind === "format") {
      const primary = connection.fields.find((f) => f.required);
      const value = values[primary.key] ?? "";
      const ok = new RegExp(spec.pattern).test(value);
      return ok
        ? {
            ok: true,
            status: "valid",
            detail: "format check passed (not sent anywhere)",
          }
        : {
            ok: false,
            status: "invalid",
            detail: "value does not match expected format",
          };
    }
    return {
      ok: true,
      status: "unchecked",
      detail: "no probe for this connection; its suites are the proof",
    };
  } catch (error) {
    return {
      ok: false,
      status: "error",
      detail: `probe failed: ${error?.message ?? error}`,
    };
  }
}
