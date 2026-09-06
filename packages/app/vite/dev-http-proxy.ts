import type { HttpProxy } from "vite";

/** Keep a disconnected dev API response from leaving its browser stream open. */
export function configureDevApiProxy(proxy: HttpProxy.ProxyServer): void {
  proxy.on("error", (_error, _request, response) => {
    if (!("headersSent" in response)) return;
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "API server unavailable" }));
  });

  proxy.on("proxyRes", (upstream, _request, downstream) => {
    const closeInterruptedResponse = () => {
      // A normal response also emits close. Only an incomplete HTTP response
      // lost its upstream: destroying that pipe makes the client settle its
      // interrupted turn without imposing a deadline on a quiet live stream.
      if (!upstream.complete && !downstream.destroyed) downstream.destroy();
    };
    // A reset after headers belongs to the upstream IncomingMessage; Vite's
    // proxy-level error handler does not receive it. Observe the body error as
    // well as close so it cannot become an unhandled EventEmitter error.
    upstream.once("error", closeInterruptedResponse);
    upstream.once("close", closeInterruptedResponse);
  });
}
