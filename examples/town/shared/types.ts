export type Vector2 = {
  x: number;
  y: number;
};

export const DEFAULT_VISION_RANGE_TILES = 6;
export const DEFAULT_AUDIO_RANGE_TILES = 6;

export type TownAgentStatus = "idle" | "moving" | "thinking" | "speaking";

export type TownAgent = {
  id: string;
  name: string;
  characterId: string;
  position: Vector2;
  renderPosition?: Vector2;
  visionRangeTiles: number;
  audioRangeTiles: number;
  orientation: number;
  status: TownAgentStatus;
  lastAction: string | null;
  lastActionExpiresAt: number | null;
  lastMessage: string | null;
  lastMessageExpiresAt: number | null;
  emote: string | null;
  emoteExpiresAt: number | null;
};

export type TownMessage = {
  id: string;
  conversationId: string | null;
  authorId: string;
  authorName: string;
  participants: string[];
  text: string;
  createdAt: number;
};

export type TownObjectiveStatus = "pending" | "completed";

export type TownObjective = {
  id: string;
  title: string;
  description: string;
  round: number;
  location: Vector2;
  poiId?: string;
  assignedAgentIds: string[];
  completedBy: string[];
  status: TownObjectiveStatus;
};

export type TownState = {
  now: number;
  agents: TownAgent[];
  messages: TownMessage[];
  objectives: TownObjective[];
};

export type AnimatedSprite = {
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
  sheet: string;
  animation: string;
};

export type WorldMapData = {
  width: number;
  height: number;
  tileSetUrl: string;
  tileSetDimX: number;
  tileSetDimY: number;
  tileDim: number;
  bgTiles: number[][][];
  objectTiles: number[][][];
  animatedSprites: AnimatedSprite[];
};
