/** Supplies the native host boundary for browser-only desktop renderer tests; storage is synthetic and local to each page load. */
import type { Page } from "@playwright/test";

export async function installDesktopBridgeFixture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const secureStore = new Map<string, string>();
    Object.assign(window, {
      __electrobunWindowId: 1,
      __ELIZA_ELECTROBUN_RPC__: {
        request: {
          desktopGetVersion: async () => ({ runtime: "playwright-smoke" }),
          desktopRegisterShortcut: async () => ({ success: true }),
          desktopSetTrayMenu: async () => undefined,
          secureStoreGet: async ({ kind }: { kind: string }) =>
            secureStore.has(kind)
              ? { ok: true, value: secureStore.get(kind) }
              : { ok: false, reason: "not_found" },
          secureStoreSet: async ({
            kind,
            value,
          }: {
            kind: string;
            value: string;
          }) => {
            secureStore.set(kind, value);
            return { ok: true };
          },
          secureStoreDelete: async ({ kind }: { kind: string }) => ({
            ok: true,
            deleted: secureStore.delete(kind),
          }),
        },
        onMessage: () => undefined,
        offMessage: () => undefined,
      },
    });
  });
}
