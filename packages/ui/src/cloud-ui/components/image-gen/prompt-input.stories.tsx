import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import {
  type AspectRatio,
  ImagePromptInput,
  type StylePreset,
} from "./prompt-input";

const meta = {
  title: "CloudUI/ImageGen/ImagePromptInput",
  component: ImagePromptInput,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
  args: {
    prompt: "",
    onPromptChange: () => {},
    onSubmit: (e: React.FormEvent) => {
      e.preventDefault();
    },
    isLoading: false,
    numImages: 1,
    onNumImagesChange: () => {},
    aspectRatio: "1:1" as AspectRatio,
    onAspectRatioChange: () => {},
    stylePreset: "none" as StylePreset,
    onStylePresetChange: () => {},
  },
} satisfies Meta<typeof ImagePromptInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const WithPrompt: Story = {
  args: {
    prompt:
      "A serene mountain lake at sunrise, mist rising from the water, golden light reflecting off the snow-capped peaks",
    numImages: 2,
    aspectRatio: "16:9",
    stylePreset: "photographic",
  },
};

export const Loading: Story = {
  args: {
    prompt: "Cyberpunk samurai standing under neon signs in a rainy alley",
    isLoading: true,
    numImages: 4,
    aspectRatio: "9:16",
    stylePreset: "neon-punk",
  },
};

export const FantasyArtPortrait: Story = {
  args: {
    prompt:
      "Ancient elven sorceress with glowing runes floating around her, intricate armor, dramatic lighting",
    numImages: 3,
    aspectRatio: "3:4",
    stylePreset: "fantasy-art",
  },
};

export const Interactive: Story = {
  render: () => {
    const InteractiveWrapper = () => {
      const [prompt, setPrompt] = useState(
        "A cozy bookshop interior at golden hour",
      );
      const [numImages, setNumImages] = useState(2);
      const [aspectRatio, setAspectRatio] = useState<AspectRatio>("4:3");
      const [stylePreset, setStylePreset] = useState<StylePreset>("cinematic");
      const [isLoading, setIsLoading] = useState(false);

      return (
        <ImagePromptInput
          prompt={prompt}
          onPromptChange={setPrompt}
          onSubmit={(e) => {
            e.preventDefault();
            setIsLoading(true);
            setTimeout(() => setIsLoading(false), 2000);
          }}
          isLoading={isLoading}
          numImages={numImages}
          onNumImagesChange={setNumImages}
          aspectRatio={aspectRatio}
          onAspectRatioChange={setAspectRatio}
          stylePreset={stylePreset}
          onStylePresetChange={setStylePreset}
        />
      );
    };
    return <InteractiveWrapper />;
  },
};
