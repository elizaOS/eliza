import type { RegistryAppInfo } from "../../api";
import {
  getInternalToolAppHasDetailsPage,
  isInternalToolApp,
} from "../apps/internal-tool-apps";
import { isOverlayApp } from "../apps/overlay-app-registry";

/**
 * Convenience: does this slug resolve to an app that wants the details
 * page? Used by AppsView.handleLaunch to decide whether to navigate to
 * /apps/<slug>/details or call openAppRouteWindow directly.
 *
 * Internal tools opt in with `hasDetailsPage`; catalog apps opt in through
 * launch metadata that implies setup, runtime control, or a heavier session.
 */
export function appNeedsDetailsPage(app: RegistryAppInfo | string): boolean {
  const name = typeof app === "string" ? app : app.name;
  if (isInternalToolApp(name)) {
    return getInternalToolAppHasDetailsPage(name);
  }
  if (isOverlayApp(name)) {
    return false;
  }
  if (typeof app !== "string" && app.launchType === "overlay") {
    return false;
  }
  if (typeof app === "string") {
    return false;
  }
  if (app.uiExtension?.detailPanelId) {
    return true;
  }
  if (app.session) {
    return true;
  }
  if (app.category.trim().toLowerCase() === "game") {
    return true;
  }
  return false;
}
