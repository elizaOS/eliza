/**
 * E2e-only PostHog session capture: streams autocapture events and rrweb
 * session-recording snapshots to the local capture sink
 * (`scripts/e2e-artifacts/posthog-sink.mjs`) so every Playwright test bundle
 * gets a replayable session (#15972). This NEVER runs in production: the only
 * activation signal is `window.__ELIZA_E2E`, injected via addInitScript by
 * the Playwright artifact fixtures (`packages/app/test/e2e-artifacts/
 * fixtures.ts`) — the global cannot exist outside an instrumented e2e page,
 * and main.tsx only imports this chunk after checking for it, so real boots
 * never even load the code.
 *
 * The full no-external posthog-js bundle is imported deliberately: the
 * default entry lazy-loads the rrweb recorder from
 * `<api_host>/static/recorder.js`, and the sink stubs every GET with an empty
 * 200, so recording would never start — the no-external build ships the
 * recorder inline. Input masking is off because e2e data is synthetic by
 * construction; the same instrumentation points at a real posthog-foss
 * instance by swapping the host (see
 * packages/docs/development/e2e-artifacts-session-replay.md).
 */

interface ElizaE2eHandshake {
  testId: string;
  posthogHost: string;
}

export async function initE2eSessionCapture(): Promise<void> {
  const handshake = (window as Window & { __ELIZA_E2E?: ElizaE2eHandshake })
    .__ELIZA_E2E;
  if (!handshake || typeof handshake.posthogHost !== "string" || handshake.posthogHost.length === 0) {
    return;
  }
  const { default: posthog } = await import(
    "posthog-js/dist/module.full.no-external.js"
  );
  // The sink accepts any project key; a fixed marker keeps captured payloads
  // recognizably synthetic if they ever reach a real PostHog instance.
  posthog.init("e2e-local", {
    api_host: handshake.posthogHost,
    autocapture: true,
    capture_pageview: true,
    advanced_disable_decide: false,
    disable_session_recording: false,
    session_recording: {
      maskAllInputs: false,
      recordCrossOriginIframes: false,
    },
    loaded: (instance) => {
      // Super property carried by every event — the sink routes traffic into
      // per-test artifact bundles by it. Recording is force-started so the
      // capture never depends on sampling/trigger evaluation.
      instance.register({ eliza_test_id: handshake.testId });
      instance.startSessionRecording();
    },
  });
}
