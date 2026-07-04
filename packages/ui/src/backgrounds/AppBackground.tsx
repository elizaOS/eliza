/**
 * The unified app background mounted once at the shell root: renders the persisted
 * BackgroundConfig as a ShaderBackground or ImageBackground and installs the
 * background:apply channel. See the backgrounds section of the package CLAUDE.md.
 */
import type * as React from "react";
import { lazy, Suspense, useState } from "react";
import type { ShaderConfig } from "../state/ui-preferences";
import { DEFAULT_BACKGROUND_COLOR } from "../state/ui-preferences";
import { useBackgroundConfig } from "../state/useBackgroundConfig";
import { ImageBackground } from "./ImageBackground";
import { ShaderBackground } from "./ShaderBackground";
import { useBackgroundApplyChannel } from "./useBackgroundApplyChannel";

// three.js (~1.5 MB raw / ~320 KB brotli) is only needed for the opt-in GLSL
// programmable-background mode — never for the default plain/preset shader that
// every session paints at boot. A static import here pulled the whole
// `vendor-three` chunk onto the first-paint (eager) graph because `AppBackground`
// mounts at the shell root and is statically imported by `App.tsx`. Loading it
// lazily keeps three off the boot path; it loads only when a user actually
// selects a GLSL shader, and the plain `ShaderBackground` (same color) paints as
// the Suspense fallback so the swap is seamless.
const ProgrammableShaderBackground = lazy(() =>
  import("./ProgrammableShaderBackground").then((m) => ({
    default: m.ProgrammableShaderBackground,
  })),
);

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
    <Suspense fallback={<ShaderBackground color={color} />}>
      <ProgrammableShaderBackground
        source={shader.source}
        uniforms={shader.uniforms}
        color={color}
        onFallback={() => setFailed(true)}
      />
    </Suspense>
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
