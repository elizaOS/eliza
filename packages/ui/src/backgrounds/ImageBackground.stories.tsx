/**
 * Storybook stories for the ImageBackground cover layer.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { ImageBackground } from "./ImageBackground";

// A tiny inline SVG data URL keeps the story self-contained and byte-stable.
const SAMPLE_IMAGE =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
       <rect width="64" height="64" fill="#059669"/>
       <circle cx="32" cy="32" r="18" fill="#f4f4f5"/>
     </svg>`,
  );

/**
 * `ImageBackground` paints a full-bleed cover image for the unified app
 * background. It is `fixed inset-0`, so the story wraps it in a relative frame.
 */
const meta = {
  title: "Backgrounds/ImageBackground",
  component: ImageBackground,
  tags: ["autodocs"],
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
} satisfies Meta<typeof ImageBackground>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { imageUrl: SAMPLE_IMAGE },
};
