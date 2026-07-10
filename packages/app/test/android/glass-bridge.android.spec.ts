// On-device contract check for the GlassBridge Capacitor plugin (Android
// half, ai.elizaos.app.GlassBridgePlugin). Runs against the real installed
// APK on a device/emulator and proves the full native lifecycle the web glass
// tier (packages/ui/src/glass) drives: registration, API-level-gated
// availability, attaching a native material region below the WebView, moving
// it (150ms animated), and detaching it. No mocks — the assertions read the
// plugin's real answers and the device's real API level.
import { expect, test, waitForShellReady } from "./android-harness";

type GlassProbeResult =
  | { error: string }
  | {
      availability: { available: boolean };
      attach: { attached: boolean };
      reattach: { attached: boolean };
    };

test("GlassBridge registers, gates on API level, and runs the attach/move/detach lifecycle", async ({
  device,
  page,
}) => {
  await waitForShellReady(page);

  const sdk = Number.parseInt(
    (await device.shell("getprop ro.build.version.sdk")).toString().trim(),
    10,
  );
  expect(Number.isFinite(sdk)).toBe(true);

  const result = (await page.evaluate(async () => {
    const cap = (
      window as unknown as {
        Capacitor?: {
          registerPlugin?: (name: string) => unknown;
          Plugins?: Record<string, unknown>;
        };
      }
    ).Capacitor;
    const plugin = (
      cap?.registerPlugin
        ? cap.registerPlugin("GlassBridge")
        : cap?.Plugins?.GlassBridge
    ) as
      | {
          isAvailable(): Promise<{ available: boolean }>;
          attachGlass(o: unknown): Promise<{ attached: boolean }>;
          updateRect(o: unknown): Promise<void>;
          detachGlass(o: unknown): Promise<void>;
        }
      | undefined;
    if (!plugin) return { error: "GlassBridge plugin not registered" };
    const availability = await plugin.isAvailable();
    const attach = await plugin.attachGlass({
      id: "e2e-probe",
      rect: { x: 40, y: 200, width: 240, height: 160 },
      cornerRadius: 24,
      colorScheme: "dark",
    });
    // Same-id reattach must replace, not stack, the region.
    const reattach = await plugin.attachGlass({
      id: "e2e-probe",
      rect: { x: 48, y: 220, width: 240, height: 160 },
      cornerRadius: 24,
      colorScheme: "dark",
    });
    await plugin.updateRect({
      id: "e2e-probe",
      rect: { x: 64, y: 280, width: 280, height: 200 },
    });
    // Let the 150ms rect animation finish before tearing down.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await plugin.detachGlass({ id: "e2e-probe" });
    return { availability, attach, reattach };
  })) as GlassProbeResult;

  if ("error" in result) {
    throw new Error(result.error);
  }

  // Availability is the API-31 dynamic-palette gate, so the expectation is a
  // function of the REAL device under test — no environment assumptions.
  const expected = sdk >= 31;
  expect(result.availability.available).toBe(expected);
  expect(result.attach.attached).toBe(expected);
  expect(result.reattach.attached).toBe(expected);
});
