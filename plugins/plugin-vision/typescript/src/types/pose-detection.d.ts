declare module '@tensorflow-models/pose-detection' {
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

  export interface PoseDetector {
    estimatePoses(input: any, config?: any): Promise<Pose[]>;
    dispose(): void;
  }

  export enum SupportedModels {
    PoseNet = 'PoseNet',
    MoveNet = 'MoveNet',
    BlazePose = 'BlazePose',
  }

  export interface PosenetModelConfig {
    architecture?: 'MobileNetV1' | 'ResNet50';
    outputStride?: number;
    inputResolution?: { width: number; height: number };
    multiplier?: number;
  }

  export function createDetector(
    model: SupportedModels,
    config?: PosenetModelConfig | any
  ): Promise<PoseDetector>;
}
