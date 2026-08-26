/**
 * Owns the Phone page chrome in the plugin that owns the dialer surface.
 * Native registration mounts this wrapper directly so the shared UI package
 * does not import or frame the phone feature.
 */

import { ViewHeader } from "@elizaos/ui/components";
import { PhoneView } from "./PhoneView.tsx";

export function PhonePage(): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <ViewHeader title="Phone" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PhoneView />
      </div>
    </div>
  );
}
