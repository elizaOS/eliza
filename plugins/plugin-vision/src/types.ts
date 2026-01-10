// Vision service types and interfaces
export const VisionServiceType = {
  VISION: 'VISION' as const,
};

// Vision-specific types
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
  audioTranscription?: string; // Latest audio transcription
}

export interface DetectedObject {
  id: string;
  type: string;
  confidence: number;
  boundingBox: BoundingBox;
}

export interface PersonInfo {
  id: string;
  pose: 'sitting' | 'standing' | 'lying' | 'unknown';
  facing: 'camera' | 'away' | 'left' | 'right' | 'unknown';
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
  format: 'rgb' | 'rgba' | 'jpeg' | 'png';
}

// Vision modes
export enum VisionMode {
  OFF = 'OFF',
  CAMERA = 'CAMERA',
  SCREEN = 'SCREEN',
  BOTH = 'BOTH',
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

// Enhanced scene description with screen data
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

// Update VisionConfig
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

  // Screen vision config
  visionMode?: VisionMode;
  screenCaptureInterval?: number; // ms between screen captures
  tileSize?: number; // Size of tiles (e.g., 256 for 256x256)
  tileProcessingOrder?: 'sequential' | 'priority' | 'random';
  ocrEnabled?: boolean;
  florence2Enabled?: boolean;
  screenRegion?: {
    // Optional: capture only part of screen
    x: number;
    y: number;
    width: number;
    height: number;
  };

  // Multi-display and worker config
  displayIndex?: number; // Specific display to capture
  captureAllDisplays?: boolean; // Cycle through all displays
  targetScreenFPS?: number; // Target FPS for screen capture
  textRegions?: Array<{
    // Specific regions for OCR
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

// Entity tracking types
export interface TrackedEntity {
  id: string;
  entityType: 'person' | 'object' | 'pet';
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
  // For people
  name?: string;
  faceEmbedding?: number[];
  faceId?: string;
  clothing?: string[];
  hairColor?: string;
  accessories?: string[];

  // For objects
  objectType?: string;
  color?: string;
  size?: 'small' | 'medium' | 'large';

  // Common
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
  activeEntities: string[]; // Currently visible
  recentlyLeft: Array<{
    entityId: string;
    leftAt: number;
    lastPosition: BoundingBox;
  }>;
}
