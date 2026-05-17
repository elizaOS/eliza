/**
 * Prompt input component for image generation with advanced options.
 * Supports prompt input, number of images, aspect ratio, and style preset selection.
 *
 * @param props.prompt - Current prompt text
 * @param props.onPromptChange - Callback when prompt changes
 * @param props.onSubmit - Callback when form is submitted
 * @param props.isLoading - Whether generation is in progress
 * @param props.numImages - Number of images to generate
 * @param props.onNumImagesChange - Callback when number of images changes
 * @param props.aspectRatio - Selected aspect ratio
 * @param props.onAspectRatioChange - Callback when aspect ratio changes
 * @param props.stylePreset - Selected style preset
 * @param props.onStylePresetChange - Callback when style preset changes
 */
export type AspectRatio =
  | "1:1"
  | "16:9"
  | "9:16"
  | "4:3"
  | "3:4"
  | "21:9"
  | "9:21";
export type StylePreset =
  | "none"
  | "photographic"
  | "digital-art"
  | "comic-book"
  | "fantasy-art"
  | "analog-film"
  | "neon-punk"
  | "isometric"
  | "low-poly"
  | "origami"
  | "line-art"
  | "cinematic"
  | "3d-model";
interface PromptInputProps {
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  isLoading: boolean;
  numImages: number;
  onNumImagesChange: (num: number) => void;
  aspectRatio: AspectRatio;
  onAspectRatioChange: (ratio: AspectRatio) => void;
  stylePreset: StylePreset;
  onStylePresetChange: (preset: StylePreset) => void;
}
export declare function ImagePromptInput({
  prompt,
  onPromptChange,
  onSubmit,
  isLoading,
  numImages,
  onNumImagesChange,
  aspectRatio,
  onAspectRatioChange,
  stylePreset,
  onStylePresetChange,
}: PromptInputProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=prompt-input.d.ts.map
