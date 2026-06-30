// Fresh first-run onboarding on the real Android Capacitor WebView.
//
// QUARANTINED (#10322). #9952 moved onboarding INTO the floating
// ContinuousChatOverlay and deleted the separate full-screen onboarding
// surface, including the remote-connect-at-URL flow this lane drove: the
// `choice-remote` card, the `first-run-remote-address` input, and the
// `choice-connect` button no longer exist. The in-chat conductor only offers
// runtime cloud/local/other; `runtime:other` ("bring your own keys") now runs
// the LOCAL backend, and there is no in-chat "connect to a remote host agent at
// a URL" step (`finishRemote` exists in first-run-finish.ts but is unreachable).
//
// Device remote-connect onboarding needs a product redesign before this lane can
// be rewritten to drive the new surface — tracked in
// https://github.com/elizaOS/eliza/issues/10322. Skipped (NOT deleted) so the
// coverage gap stays visible and tracked rather than silently dropped.
import { test } from "./android-harness";

test.describe
  .serial("android onboarding to home (real Capacitor WebView)", () => {
    test("fresh first-run connects to a host agent and lands on home", () => {
      test.skip(
        true,
        "remote-connect-at-URL onboarding removed by #9952; device redesign pending — see https://github.com/elizaOS/eliza/issues/10322",
      );
    });
  });
