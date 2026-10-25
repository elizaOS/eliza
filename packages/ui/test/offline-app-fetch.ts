/**
 * Offline test doubles for the full-`<App />` fuzz suites.
 *
 * Those suites mount the entire authenticated shell, which renders ~two dozen
 * home/sidebar widgets plus the notification/slash-command shell — all of which
 * probe the agent over the network on mount. With no backend the probes settle
 * on their own schedule, often AFTER the file's jsdom environment is torn down,
 * and the widget's post-teardown `setState` throws `ReferenceError: window is
 * not defined` from react-dom's scheduler — which vitest reports as an unhandled
 * error and fails the whole Client Tests shard even though every assertion
 * passed.
 *
 * `stubOfflineAppFetch` keeps every request permanently pending (the same
 * approach the wallpaper-manifest suite already uses): a request that never
 * settles never rejects, so retry-on-failure components (the notification store)
 * never enter a backoff-retry storm and nothing is left to setState after
 * teardown. It is paired with `mockNeverTimeout` because three widgets
 * (calendar-upcoming, model-download, agent-provisioning) wrap their probe in
 * `withTimeout`, whose real timer WOULD fire seconds later — after teardown —
 * and reject the otherwise-pending probe; the pass-through neutralises that
 * timer so the probe simply stays pending too (see the inline
 * `vi.mock("./utils/with-timeout", …)` in each suite — it must be hoisted, so it
 * can't live here). Restore the fetch stub with `vi.unstubAllGlobals()` (the
 * suites already do in `afterEach`).
 */
import { vi } from "vitest";

export function stubOfflineAppFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((): Promise<Response> => new Promise<Response>(() => {})),
  );
}
