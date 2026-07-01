import type * as React from "react";
import { DEFAULT_BACKGROUND_COLOR } from "../state/ui-preferences";
import { useBackgroundConfig } from "../state/useBackgroundConfig";
import { ImageBackground } from "./ImageBackground";
import { ShaderBackground } from "./ShaderBackground";
import { useBackgroundApplyChannel } from "./useBackgroundApplyChannel";

export interface AppBackgroundProps {
  /** Render the visual wallpaper layer. The background event channel stays mounted. */
  visible?: boolean;
}

/**
 * The single, always-mounted app background. It lives at the shell root — above
 * the per-view switch — and is driven purely by the persisted background config,
 * so it never remounts when the user navigates: the home and every view that
 * opts in share one continuous, seamless background.
 *
 * Mounting here also installs the one `background:apply` listener (the agent's
 * chat → background bridge), so it is active for the whole session.
 */
export function AppBackground({
  visible = true,
}: AppBackgroundProps = {}): React.JSX.Element | null {
  const { backgroundConfig } = useBackgroundConfig();
  useBackgroundApplyChannel();
  if (!visible) return null;
  // Defensive: the app store can return a non-object slice before the provider
  // seeds it (e.g. the test fallback proxy). Fall back to the default shader.
  const config =
    backgroundConfig && typeof backgroundConfig === "object"
      ? backgroundConfig
      : null;
  if (config?.mode === "image" && config.imageUrl) {
    return <ImageBackground imageUrl={config.imageUrl} />;
  }
  return <ShaderBackground color={config?.color ?? DEFAULT_BACKGROUND_COLOR} />;
}
