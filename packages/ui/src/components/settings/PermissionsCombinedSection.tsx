/**
 * The consolidated Permissions settings subview: device/system permissions
 * (mic, notifications, …) followed by per-app permission grants, stacked in one
 * screen. Two surfaces, one row in the settings hub — the standalone
 * `app-permissions` section stays registered (deep-links resolve) but is
 * Developer-Mode-only now that this combined view is the everyday path.
 */
import { AppPermissionsSection } from "./AppPermissionsSection";
import { PermissionsSection } from "./PermissionsSection";

export function PermissionsCombinedSection(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-8">
      <PermissionsSection />
      <section aria-label="App permissions">
        <h2 className="mb-3 text-sm font-semibold text-txt-strong">
          App permissions
        </h2>
        <AppPermissionsSection />
      </section>
    </div>
  );
}
