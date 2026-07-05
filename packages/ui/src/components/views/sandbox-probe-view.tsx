/**
 * The shipped first-party consumer of the `sandboxed-iframe` isolation level
 * (#14180): a developer-only diagnostics view that renders a real framed
 * document and exercises the postMessage capability broker end to end. Before
 * this view the level was catalogued with `examples: []` — no view declared it —
 * so the isolation mechanism had no in-app proof. The probe closes that: it is a
 * genuine opaque-origin `<iframe sandbox>` that requests `navigate` and `storage`
 * over postMessage and renders the shell's granted/denied replies, letting a
 * developer see the boundary hold with their own eyes.
 *
 * Registered gated behind Developer Mode (`registerSandboxProbeView`) so it never
 * appears in the normal launcher; named as the level's consumer in
 * `surface-isolation.ts`. Consumes `SandboxedViewFrame` (the mechanism) directly.
 */

import type { SurfaceManifest } from "@elizaos/core";
import { registerAppShellPage } from "../../app-shell-registry";
import { SandboxedViewFrame } from "./SandboxedViewFrame";
import { SANDBOXED_VIEW_CHANNEL } from "./sandboxed-view-broker";

/** Stable id; the value `surface-isolation.ts` names as the level's consumer. */
export const SANDBOX_PROBE_VIEW_ID = "sandbox-probe" as const;

/**
 * The probe's declared surface: the level under test plus the two brokered grants
 * so the framed document can demonstrate both facilities succeeding. A view
 * without these grants is denied — that path is covered by the broker tests.
 */
export const SANDBOX_PROBE_MANIFEST: SurfaceManifest = {
  isolation: "sandboxed-iframe",
  capabilities: ["navigate", "storage"],
};

/**
 * The framed document. Runs on an opaque origin (the frame never gets
 * `allow-same-origin`), so it cannot touch the shell directly — every action
 * below goes through `postMessage` and is answered by the broker. Kept dependency
 * free (inline vanilla JS) because a sandboxed frame shares nothing with the host
 * bundle.
 */
export const SANDBOX_PROBE_DOC = `<!doctype html>
<html>
<head><meta charset="utf-8"><style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 16px; font: 13px system-ui, sans-serif;
         background: #0b0b0d; color: #e7e7ea; }
  h1 { font-size: 14px; margin: 0 0 12px; }
  button { font: inherit; padding: 6px 12px; margin-right: 8px; cursor: pointer;
           color: #0b0b0d; background: #ff7a1a; border: 0; border-radius: 6px; }
  button:hover { background: #e56400; }
  pre { margin-top: 12px; padding: 10px; background: #141417; border-radius: 6px;
        white-space: pre-wrap; word-break: break-word; }
</style></head>
<body>
  <h1>Sandboxed view isolation probe</h1>
  <button id="nav">Request navigate → chat</button>
  <button id="store">Request storage write</button>
  <pre id="log" data-testid="probe-log">idle</pre>
  <script>
    var CHANNEL = ${JSON.stringify(SANDBOXED_VIEW_CHANNEL)};
    var pending = {};
    var seq = 0;
    function log(line) { document.getElementById("log").textContent = line; }
    function request(capability, payload) {
      var requestId = capability + ":" + (++seq);
      return new Promise(function (resolve) {
        pending[requestId] = resolve;
        parent.postMessage(
          { channel: CHANNEL, kind: "request", requestId: requestId,
            capability: capability, payload: payload },
          "*"
        );
      });
    }
    window.addEventListener("message", function (event) {
      var data = event.data;
      if (!data || data.channel !== CHANNEL || data.kind !== "response") return;
      var resolve = pending[data.requestId];
      if (!resolve) return;
      delete pending[data.requestId];
      resolve(data);
    });
    document.getElementById("nav").addEventListener("click", function () {
      request("navigate", { viewId: "chat" }).then(function (r) {
        log(r.ok ? "navigate serviced: " + JSON.stringify(r.result)
                 : "navigate DENIED: " + r.error);
      });
    });
    document.getElementById("store").addEventListener("click", function () {
      request("storage", { op: "set", key: "probe", value: "hello" }).then(function (r) {
        log(r.ok ? "storage serviced: " + JSON.stringify(r.result)
                 : "storage DENIED: " + r.error);
      });
    });
  </script>
</body>
</html>`;

/** The developer-mode page component. */
export function SandboxProbeView() {
  return (
    <SandboxedViewFrame
      viewId={SANDBOX_PROBE_VIEW_ID}
      surface={SANDBOX_PROBE_MANIFEST}
      srcDoc={SANDBOX_PROBE_DOC}
      title="Sandboxed view isolation probe"
    />
  );
}

/**
 * Register the probe as a developer-only nav page. Idempotent (the registry keys
 * by id), so a host may call it at boot without guarding against double-register.
 */
export function registerSandboxProbeView(): void {
  registerAppShellPage({
    id: SANDBOX_PROBE_VIEW_ID,
    pluginId: "app-core",
    label: "Sandbox Probe",
    icon: "shield",
    path: `/apps/${SANDBOX_PROBE_VIEW_ID}`,
    developerOnly: true,
    surface: SANDBOX_PROBE_MANIFEST,
    Component: SandboxProbeView,
  });
}
