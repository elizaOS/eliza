import type { CSSProperties, JSX } from "react";

import { AvatarHost } from "../../../avatar-runtime";

const onboardingAvatarCanvasStyle = {
  width: "min(270px, 78vw)",
  height: 112,
  pointerEvents: "none",
} satisfies CSSProperties;

export function OnboardingAvatar(): JSX.Element {
  return (
    <div
      className="eliza-ob-agent-canvas"
      style={onboardingAvatarCanvasStyle}
      aria-hidden="true"
    >
      <AvatarHost />
    </div>
  );
}
