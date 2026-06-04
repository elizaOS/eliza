import { LayoutGrid } from "lucide-react";
import { APPS_SECTION_VISIBILITY_KEY } from "../../widgets/visibility";
import type { WidgetVisibilityCandidate } from "./WidgetVisibilityPanel";

const APPS_SECTION_PARTS = APPS_SECTION_VISIBILITY_KEY.split("/");

export function buildAppsSectionVisibilityCandidate(): WidgetVisibilityCandidate {
  return {
    pluginId: APPS_SECTION_PARTS[0] ?? "app-core",
    id: APPS_SECTION_PARTS[1] ?? "apps.section",
    defaultEnabled: true,
    label: "Apps",
    icon: <LayoutGrid className="h-3.5 w-3.5" />,
  };
}
