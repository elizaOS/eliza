/**
 * Packaged-runtime test escape hatch for enabling the first-run runtime chooser.
 * The override is intentionally inert unless desktop packaging injects the test
 * global, so a user-controlled URL cannot flip local runtime selection in the
 * normal web app.
 */
import { shellLocalStorage } from "@elizaos/ui/bridge";

const RUNTIME_CHOOSER_OVERRIDE_PARAM = "enableRuntimeChooser";
const RUNTIME_CHOOSER_OVERRIDE_STORAGE_KEY = "eliza:enable-runtime-chooser";
const FIRST_RUN_COMPLETE_STORAGE_KEY = "eliza:first-run-complete";
const DESKTOP_RUNTIME_CHOOSER_TEST_GLOBAL =
  "__ELIZA_DESKTOP_TEST_ENABLE_RUNTIME_CHOOSER__";

declare global {
  interface Window {
    __ELIZA_DESKTOP_TEST_ENABLE_RUNTIME_CHOOSER__?: boolean;
  }
}

function getWindowUrlSearchParams(win: Window): URLSearchParams {
  const search = win.location?.search ?? "";
  const hashSearch = win.location?.hash?.split("?")[1] ?? "";
  return new URLSearchParams(search || hashSearch);
}

function hasDesktopRuntimeChooserTestInjection(win: Window): boolean {
  return Reflect.get(win, DESKTOP_RUNTIME_CHOOSER_TEST_GLOBAL) === true;
}

export function applyRuntimeChooserOverrideFromUrl(win = window): boolean {
  if (!hasDesktopRuntimeChooserTestInjection(win)) {
    return false;
  }

  const params = getWindowUrlSearchParams(win);
  if (params.get(RUNTIME_CHOOSER_OVERRIDE_PARAM) !== "1") {
    return false;
  }

  try {
    // The packaged test seam must enter a genuinely fresh first-run. Native
    // persistence can rehydrate this reserved completion key even when the
    // WebView partition itself is new, which otherwise skips the conductor and
    // leaves the runtime-choice selector absent. Route both writes through the
    // privileged shell channel so the reserved-key guard remains intact.
    shellLocalStorage.removeItem(FIRST_RUN_COMPLETE_STORAGE_KEY);
    shellLocalStorage.setItem(RUNTIME_CHOOSER_OVERRIDE_STORAGE_KEY, "1");
    win.history.replaceState(
      win.history.state,
      "",
      removeUrlParameter(win.location.href, RUNTIME_CHOOSER_OVERRIDE_PARAM),
    );
    return true;
  } catch {
    // error-policy:J3 storage/history can be unavailable in constrained webviews; keep booting.
    return false;
  }
}

export function removeUrlParameter(href: string, parameter: string): URL {
  const nextUrl = new URL(href);
  nextUrl.searchParams.delete(parameter);
  const hashQueryIndex = nextUrl.hash.indexOf("?");
  if (hashQueryIndex >= 0) {
    const hashPath = nextUrl.hash.slice(0, hashQueryIndex);
    const hashParams = new URLSearchParams(
      nextUrl.hash.slice(hashQueryIndex + 1),
    );
    hashParams.delete(parameter);
    const serializedHashParams = hashParams.toString();
    nextUrl.hash = serializedHashParams
      ? `${hashPath}?${serializedHashParams}`
      : hashPath;
  }
  return nextUrl;
}
