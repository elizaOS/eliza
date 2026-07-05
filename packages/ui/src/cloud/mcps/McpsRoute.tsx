/**
 * MCPs cloud route entry.
 *
 * Gates on the Steward session (the registry CRUD routes require auth), then
 * renders {@link McpsView}. The same {@link McpsSurface} backs both the
 * standalone route and the Settings-section wrapper, so they stay identical.
 * `McpsView` sets the page header, so each entry point supplies a
 * `PageHeaderProvider`: the standalone route wraps one here; the settings
 * section gets it from `CloudSettingsSectionShell`.
 */

import { DashboardLoadingState } from "../../cloud-ui/components/dashboard/route-placeholders";
import { PageHeaderProvider } from "../../cloud-ui/components/layout";
import { useSessionAuth } from "../lib/use-session-auth";
import { useCloudT } from "../shell/CloudI18nProvider";
import { McpsView } from "./McpsView";

/** The MCPs surface. Embeddable by the settings section and the standalone route. */
export function McpsSurface() {
  const t = useCloudT();
  // Console-wide session truth (SDK context OR persisted JWT) — the raw SDK
  // context is empty on every full page load (MemoryStorage), which left this
  // surface stuck on the loading state for signed-in users, same as the
  // admin-gate bug fixed alongside.
  const { ready, authenticated } = useSessionAuth();

  if (!ready || !authenticated) {
    return (
      <DashboardLoadingState
        label={t("cloud.mcps.loading", { defaultValue: "Loading MCPs" })}
      />
    );
  }

  return <McpsView />;
}

/** Default export consumed by the cloud-route registry. */
export default function McpsRoute() {
  return (
    <PageHeaderProvider>
      <McpsSurface />
    </PageHeaderProvider>
  );
}
