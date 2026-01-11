declare module "@tensorflow-models/pose-detection" {
  export interface Keypoint {
    x: number;
    y: number;
    z?: number;
    score?: number;
    name?: string;
  }

  export interface Pose {
    keypoints: Keypoint[];
    score?: number;
  }

  /**
   * Supported input types for pose estimation.
   * Matches TensorFlow.js PixelData and common browser/node image types.
   */
  export type PoseDetectorInput =
    | ImageData
    | HTMLImageElement
    | HTMLVideoElement
    | HTMLCanvasElement
    | {
        data: Uint8ClampedArray | Float32Array;
        width: number;
        height: number;
      };

  /**
   * Configuration options for estimatePoses method.
   */
  export interface EstimatePosesConfig {
    /** Maximum number of poses to detect */
    maxPoses?: number;
    /** Whether to flip the poses horizontally */
    flipHorizontal?: boolean;
    /** Score threshold for pose detection */
    scoreThreshold?: number;
  }

  export interface PoseDetector {
    estimatePoses(input: PoseDetectorInput, config?: EstimatePosesConfig): Promise<Pose[]>;
    dispose(): void;
  }

  export enum SupportedModels {
    PoseNet = "PoseNet",
    MoveNet = "MoveNet",
    BlazePose = "BlazePose",
  }

  export interface PosenetModelConfig {
    architecture?: "MobileNetV1" | "ResNet50";
    outputStride?: number;
    inputResolution?: { width: number; height: number };
    multiplier?: number;
  }

  export interface MoveNetModelConfig {
    modelType?: "SinglePose.Lightning" | "SinglePose.Thunder" | "MultiPose.Lightning";
    enableSmoothing?: boolean;
    minPoseScore?: number;
    multiPoseMaxDimension?: number;
    enableTracking?: boolean;
    trackerType?: "keypoint" | "boundingBox";
    trackerConfig?: Record<string, unknown>;
  }

  export interface BlazePoseModelConfig {
    runtime?: "mediapipe" | "tfjs";
    enableSmoothing?: boolean;
    modelType?: "lite" | "full" | "heavy";
    solutionPath?: string;
  }

  /**
   * Model-specific configuration type mapping.
   */
  export type ModelConfig<T extends SupportedModels> = T extends SupportedModels.PoseNet
    ? PosenetModelConfig
    : T extends SupportedModels.MoveNet
      ? MoveNetModelConfig
      : T extends SupportedModels.BlazePose
        ? BlazePoseModelConfig
        : PosenetModelConfig | MoveNetModelConfig | BlazePoseModelConfig;

  export function createDetector<T extends SupportedModels>(
    model: T,
    config?: ModelConfig<T>
  ): Promise<PoseDetector>;
}
