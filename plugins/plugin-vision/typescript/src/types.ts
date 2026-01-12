export const VisionServiceType = {
  VISION: "VISION" as const,
};

declare module "@elizaos/core" {
  interface ServiceTypeRegistry {
    VISION: "VISION";
  }
}

export interface CameraInfo {
  id: string;
  name: string;
  connected: boolean;
}

export interface SceneDescription {
  timestamp: number;
  description: string;
  objects: DetectedObject[];
  people: PersonInfo[];
  sceneChanged: boolean;
  changePercentage: number;
  audioTranscription?: string;
}

export interface DetectedObject {
  id: string;
  type: string;
  confidence: number;
  boundingBox: BoundingBox;
}

export interface PersonInfo {
  id: string;
  pose: "sitting" | "standing" | "lying" | "unknown";
  facing: "camera" | "away" | "left" | "right" | "unknown";
  confidence: number;
  boundingBox: BoundingBox;
  keypoints?: Array<{
    part: string;
    position: { x: number; y: number };
    score: number;
  }>;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisionFrame {
  timestamp: number;
  width: number;
  height: number;
  data: Buffer;
  format: "rgb" | "rgba" | "jpeg" | "png";
}

export enum VisionMode {
  OFF = "OFF",
  CAMERA = "CAMERA",
  SCREEN = "SCREEN",
  BOTH = "BOTH",
}

// Screen capture types
export interface ScreenCapture {
  timestamp: number;
  width: number;
  height: number;
  data: Buffer;
  tiles: ScreenTile[];
}

export interface ScreenTile {
  id: string;
  row: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
  data?: Buffer;
  analysis?: TileAnalysis;
}

export interface TileAnalysis {
  timestamp: number;
  florence2?: Florence2Result;
  ocr?: OCRResult;
  objects?: DetectedObject[];
  text?: string;
  summary?: string;
}

export interface Florence2Result {
  caption?: string;
  objects?: Array<{
    label: string;
    bbox: BoundingBox;
    confidence: number;
  }>;
  regions?: Array<{
    description: string;
    bbox: BoundingBox;
  }>;
  tags?: string[];
}

export interface OCRResult {
  text: string;
  blocks: Array<{
    text: string;
    bbox: BoundingBox;
    confidence: number;
    words?: Array<{
      text: string;
      bbox: BoundingBox;
      confidence: number;
    }>;
  }>;
  fullText: string;
}

export interface EnhancedSceneDescription extends SceneDescription {
  screenCapture?: ScreenCapture;
  screenAnalysis?: {
    fullScreenOCR?: string;
    activeTile?: TileAnalysis;
    gridSummary?: string;
    focusedApp?: string;
    uiElements?: Array<{
      type: string;
      text: string;
      position: BoundingBox;
    }>;
  };
}

export interface VisionConfig {
  cameraName?: string;
  pixelChangeThreshold?: number;
  updateInterval?: number;
  enablePoseDetection?: boolean;
  enableObjectDetection?: boolean;
  tfUpdateInterval?: number;
  vlmUpdateInterval?: number;
  tfChangeThreshold?: number;
  vlmChangeThreshold?: number;
  visionMode?: VisionMode;
  screenCaptureInterval?: number;
  tileSize?: number;
  tileProcessingOrder?: "sequential" | "priority" | "random";
  ocrEnabled?: boolean;
  florence2Enabled?: boolean;
  screenRegion?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  displayIndex?: number;
  captureAllDisplays?: boolean;
  targetScreenFPS?: number;
  textRegions?: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

export interface TrackedEntity {
  id: string;
  entityType: "person" | "object" | "pet";
  firstSeen: number;
  lastSeen: number;
  lastPosition: BoundingBox;
  appearances: EntityAppearance[];
  attributes: EntityAttributes;
  worldId?: string;
  roomId?: string;
}

export interface EntityAppearance {
  timestamp: number;
  boundingBox: BoundingBox;
  confidence: number;
  embedding?: number[]; // Face embedding for person recognition
  keypoints?: Array<{
    part: string;
    position: { x: number; y: number };
    score: number;
  }>;
}

export interface EntityAttributes {
  [key: string]: string | number | boolean | null | undefined | string[] | number[];
  name?: string;
  faceEmbedding?: number[];
  faceId?: string;
  clothing?: string[];
  hairColor?: string;
  accessories?: string[];

  // For objects
  objectType?: string;
  color?: string;
  size?: "small" | "medium" | "large";
  description?: string;
  tags?: string[];
}

export interface FaceLibrary {
  faces: Map<string, FaceProfile>;
  embeddings: Map<string, number[][]>; // Multiple embeddings per profile
}

export interface FaceProfile {
  id: string;
  name?: string;
  embeddings: number[][]; // Multiple embeddings for better recognition
  firstSeen: number;
  lastSeen: number;
  seenCount: number;
  attributes?: {
    age?: string;
    gender?: string;
    emotion?: string;
  };
}

export interface WorldState {
  worldId: string;
  entities: Map<string, TrackedEntity>;
  lastUpdate: number;
  activeEntities: string[];
  recentlyLeft: Array<{
    entityId: string;
    leftAt: number;
    lastPosition: BoundingBox;
  }>;
}
