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

import { useContext } from "react";
import { PageHeaderProvider } from "../../cloud-ui";
import { DashboardLoadingState } from "../../cloud-ui/components/dashboard/route-placeholders";
import { useCloudT } from "../shell/CloudI18nProvider";
import { LocalStewardAuthContext } from "../shell/StewardProvider";
import { McpsView } from "./McpsView";

/** The MCPs surface. Embeddable by the settings section and the standalone route. */
export function McpsSurface() {
  const t = useCloudT();
  const auth = useContext(LocalStewardAuthContext);
  const ready = auth ? !auth.isLoading : false;
  const authenticated = auth?.isAuthenticated ?? false;

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
