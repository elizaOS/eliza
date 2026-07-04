/**
 * Storybook stories for the ProgrammableShaderBackground across presets.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { ProgrammableShaderBackground } from "./ProgrammableShaderBackground";
import { getShaderPreset } from "./shader-presets";
import { DEFAULT_SHADER_UNIFORMS } from "./shader-schema";

/**
 * `ProgrammableShaderBackground` runs an arbitrary GLSL fragment shader via
 * three.js (#10694). Under the story-gate's headless Chromium it renders real
 * pixels; if WebGL is unavailable it paints the base color (the safety
 * fallback). It is `fixed inset-0`, so each story wraps it in a
 * relatively-positioned frame.
 */
const meta = {
  title: "Backgrounds/ProgrammableShaderBackground",
  component: ProgrammableShaderBackground,
  decorators: [
    (Story) => (
      <div
        style={{
          position: "relative",
          width: "100%",
          height: 320,
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProgrammableShaderBackground>;

export default meta;
type Story = StoryObj<typeof meta>;

const aurora = getShaderPreset("aurora")?.source ?? "";
const lava = getShaderPreset("lava")?.source ?? "";
const nebula = getShaderPreset("nebula")?.source ?? "";

export const Aurora: Story = {
  args: { source: aurora, uniforms: DEFAULT_SHADER_UNIFORMS, color: "#059669" },
};

export const Lava: Story = {
  args: { source: lava, uniforms: DEFAULT_SHADER_UNIFORMS, color: "#dc2626" },
};

export const Nebula: Story = {
  args: {
    source: nebula,
    uniforms: { ...DEFAULT_SHADER_UNIFORMS, u_scale: 2, u_intensity: 1.3 },
    color: "#7c3aed",
  },
};

/** A deliberately broken shader — the component must fall back, not crash. */
export const BrokenSourceFallsBack: Story = {
  args: {
    source: "this is not valid glsl",
    uniforms: DEFAULT_SHADER_UNIFORMS,
    color: "#ef5a1f",
  },
};
