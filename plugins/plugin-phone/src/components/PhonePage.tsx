/**
 * Owns the Phone page chrome in the plugin that owns the dialer surface.
 * Native registration mounts this wrapper directly so the shared UI package
 * does not import or frame the phone feature.
 */

import { PluginPageFrame } from "@elizaos/ui/components";
import { PhoneView } from "./PhoneView.tsx";

export function PhonePage(): React.JSX.Element {
  return (
    <PluginPageFrame title="Phone" contentOverflow="auto">
      <PhoneView />
    </PluginPageFrame>
  );
}
