/**
 * Story fixtures for the chat-sheet liquid-glass recipe. A colorful mock
 * backdrop stands in for the ember field + home widgets behind an inset panel
 * that layers the frosted fill, specular sheen, and bevel so the glass edge is
 * reviewable in isolation without booting the full shell.
 */
import type { Meta, StoryObj } from "@storybook/react";

import { LIQUID_GLASS_EDGE_SHADOW, LIQUID_GLASS_SHEEN } from "./liquid-glass";

function Backdrop(): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        background:
          "radial-gradient(120% 90% at 20% 15%, #ff7a3d 0%, #b5341f 45%, #2a0f0a 100%)",
      }}
    >
      {["18% 30%", "62% 22%", "40% 60%", "72% 68%"].map((pos, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static decorative tiles
          key={i}
          style={{
            position: "absolute",
            left: pos.split(" ")[0],
            top: pos.split(" ")[1],
            width: 120,
            height: 72,
            borderRadius: 16,
            background: "rgba(255,255,255,0.14)",
            border: "1px solid rgba(255,255,255,0.25)",
          }}
        />
      ))}
    </div>
  );
}

function GlassSheet({ radius }: { radius: number }): React.JSX.Element {
  return (
    <div
      style={{
        position: "absolute",
        left: 24,
        right: 24,
        bottom: 24,
        top: 96,
        borderRadius: radius,
        border: "1px solid rgba(255,255,255,0.28)",
        backgroundColor: "color-mix(in srgb, #1a1210 68%, transparent)",
        backdropFilter: "blur(24px) saturate(1.3)",
        WebkitBackdropFilter: "blur(24px) saturate(1.3)",
        boxShadow: LIQUID_GLASS_EDGE_SHADOW,
        backgroundImage: `${LIQUID_GLASS_SHEEN}, linear-gradient(180deg, rgba(255,255,255,0.05) 0%, transparent 22%)`,
        color: "white",
        overflow: "hidden",
      }}
    >
      <div style={{ position: "relative", padding: 20, fontSize: 14 }}>
        Liquid-glass chat sheet with inset rim, bevel, and sheen.
      </div>
    </div>
  );
}

function Frame({ radius }: { radius: number }): React.JSX.Element {
  return (
    <div style={{ position: "relative", width: 380, height: 640 }}>
      <Backdrop />
      <GlassSheet radius={radius} />
    </div>
  );
}

const meta: Meta<typeof Frame> = {
  title: "shell/LiquidGlass",
  component: Frame,
  parameters: { layout: "centered" },
};
export default meta;

type Story = StoryObj<typeof Frame>;

export const InsetSheet: Story = { args: { radius: 24 } };
export const NearlyMaximized: Story = { args: { radius: 6 } };
