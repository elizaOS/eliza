import type * as React from "react";
import { DEFAULT_BACKGROUND_COLOR } from "../state/ui-preferences";
import { useBackgroundConfig } from "../state/useBackgroundConfig";
import { ImageBackground } from "./ImageBackground";
import { ShaderBackground } from "./ShaderBackground";

/**
 * The single, always-mounted app background. It lives at the shell root — above
 * the per-view switch — and is driven purely by the persisted background config,
 * so it never remounts when the user navigates: the home and every view that
 * opts in share one continuous, seamless background.
 */
export function AppBackground(): React.JSX.Element {
  const { backgroundConfig } = useBackgroundConfig();
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
