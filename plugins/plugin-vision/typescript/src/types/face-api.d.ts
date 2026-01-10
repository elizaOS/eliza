declare module 'face-api.js' {
  export interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  export interface FaceDetection {
    box: Box;
    score: number;
  }

  export interface FaceLandmarks68 {
    positions: Array<{ x: number; y: number }>;
  }

  export interface FaceExpressions {
    neutral: number;
    happy: number;
    sad: number;
    angry: number;
    fearful: number;
    disgusted: number;
    surprised: number;
  }

  export interface AgeAndGenderPrediction {
    age: number;
    gender: string;
    genderProbability: number;
  }

  export interface WithFaceDetection<_T> {
    detection: FaceDetection;
  }

  export interface WithFaceLandmarks<_T> {
    landmarks: FaceLandmarks68;
  }

  export interface WithFaceDescriptor<_T> {
    descriptor: Float32Array;
  }

  export interface WithFaceExpressions<_T> {
    expressions: FaceExpressions;
  }

  export interface WithAgeAndGender<_T> {
    age: number;
    gender: string;
    genderProbability: number;
  }

  export type FullFaceDescription = WithFaceDetection<{}> &
    WithFaceLandmarks<{}> &
    WithFaceDescriptor<{}> &
    WithFaceExpressions<{}> &
    WithAgeAndGender<{}>;

  export const env: {
    monkeyPatch: (config: any) => void;
  };

  export const nets: {
    ssdMobilenetv1: {
      loadFromDisk: (path: string) => Promise<void>;
    };
    faceLandmark68Net: {
      loadFromDisk: (path: string) => Promise<void>;
    };
    faceRecognitionNet: {
      loadFromDisk: (path: string) => Promise<void>;
    };
    faceExpressionNet: {
      loadFromDisk: (path: string) => Promise<void>;
    };
    ageGenderNet: {
      loadFromDisk: (path: string) => Promise<void>;
    };
  };

  export class SsdMobilenetv1Options {
    constructor(options: { minConfidence?: number; maxResults?: number });
  }

  export function detectAllFaces(
    input: any,
    options?: any
  ): {
    withFaceLandmarks(): any;
    withFaceDescriptors(): any;
    withFaceExpressions(): any;
    withAgeAndGender(): any;
  };
}
