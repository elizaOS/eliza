/**
 * Drives post-startup packaged renderer surfaces through the native eval
 * bridge while preserving the same user-visible actions as a real walkthrough.
 */
import type { PackagedDesktopHarness } from "./packaged-app-helpers";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function dismissPermissionPrimingIfShown(
  harness: PackagedDesktopHarness,
  appearanceTimeoutMs = 3_000,
): Promise<"absent" | "dismissed"> {
  const appearanceDeadline = Date.now() + appearanceTimeoutMs;
  let modalObserved = false;
  while (Date.now() < appearanceDeadline || modalObserved) {
    const state = await harness.eval<{
      modalPresent: boolean;
      skipPresent: boolean;
    }>(`(() => {
      const modal = document.querySelector('[data-testid="permission-priming-modal"]');
      const skip = document.querySelector('[data-testid="priming-skip-all"]');
      return {
        modalPresent: Boolean(modal),
        skipPresent: skip instanceof HTMLButtonElement && !skip.disabled,
      };
    })()`);
    modalObserved ||= state.modalPresent;
    if (!modalObserved) {
      await delay(100);
      continue;
    }
    if (state.skipPresent) {
      await harness.eval(
        `document.querySelector('[data-testid="priming-skip-all"]')?.click()`,
      );
      const dismissalDeadline = Date.now() + 10_000;
      while (Date.now() < dismissalDeadline) {
        const dismissed = await harness.eval<{
          modalPresent: boolean;
          primed: string | null;
        }>(`({
          modalPresent: Boolean(document.querySelector('[data-testid="permission-priming-modal"]')),
          primed: localStorage.getItem('eliza:permissions-primed'),
        })`);
        if (!dismissed.modalPresent && dismissed.primed === "1") {
          return "dismissed";
        }
        await delay(100);
      }
      throw new Error(
        "Permission-priming modal did not close and persist the shown-once flag after Skip for now.",
      );
    }
    if (Date.now() >= appearanceDeadline + 10_000) {
      throw new Error(
        "Permission-priming modal appeared but never exposed its Skip for now action.",
      );
    }
    await delay(100);
  }
  return "absent";
}
