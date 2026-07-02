import type * as React from "react";
import { useState } from "react";
import type { ShaderConfig } from "../state/ui-preferences";
import { DEFAULT_BACKGROUND_COLOR } from "../state/ui-preferences";
import { useBackgroundConfig } from "../state/useBackgroundConfig";
import { ImageBackground } from "./ImageBackground";
import { ProgrammableShaderBackground } from "./ProgrammableShaderBackground";
import { ShaderBackground } from "./ShaderBackground";
import { useBackgroundApplyChannel } from "./useBackgroundApplyChannel";

export interface AppBackgroundProps {
  /** Render the visual wallpaper layer. The background event channel stays mounted. */
  visible?: boolean;
}

/**
 * Programmable GLSL background with a hard guarantee: if the shader can't run
 * (no WebGL, compile error, GPU stall, context loss) it paints the plain color
 * field instead. The caller keys this by `shader.source`, so a new/replacement
 * shader remounts and gets a fresh attempt (the `failed` flag resets naturally).
 */
function GlslBackground({
  shader,
  color,
}: {
  shader: ShaderConfig;
  color: string;
}): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  if (failed) return <ShaderBackground color={color} />;
  return (
    <ProgrammableShaderBackground
      source={shader.source}
      uniforms={shader.uniforms}
      color={color}
      onFallback={() => setFailed(true)}
    />
  );
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
  const color = config?.color ?? DEFAULT_BACKGROUND_COLOR;
  if (config?.mode === "image" && config.imageUrl) {
    return <ImageBackground imageUrl={config.imageUrl} />;
  }
  if (config?.mode === "glsl" && config.shader) {
    // Key by source so a replacement shader remounts (fresh compile attempt +
    // fallback reset) instead of inheriting the prior shader's failed state.
    return (
      <GlslBackground
        key={config.shader.source}
        shader={config.shader}
        color={color}
      />
    );
  }
  return <ShaderBackground color={color} />;
}
