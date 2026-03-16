/**
 * Virtual Tabletop Types
 * Real-time multiplayer state for the VTT frontend
 */

import type { CharacterPosition } from './character';
import type { ConditionName } from './conditions';
import type { DiceRollResult } from './dice';
import type { InitiativeEntry } from './combat';

// ============================================================================
// TOKENS
// ============================================================================

export type TokenSize = 'tiny' | 'small' | 'medium' | 'large' | 'huge' | 'gargantuan';

export const TOKEN_SIZE_CELLS: Record<TokenSize, number> = {
  tiny: 0.5,
  small: 1,
  medium: 1,
  large: 2,
  huge: 3,
  gargantuan: 4,
};

export type TokenVisibility = 'all' | 'dm_only' | 'owner_only';

export interface VTTToken {
  id: string;
  entityId: string;
  entityType: 'pc' | 'npc' | 'monster';
  name: string;
  
  // Visual
  imageUrl: string;
  size: TokenSize;
  color: string;
  borderColor?: string;
  
  // Position
  position: CharacterPosition;
  elevation: number;
  
  // Status
  hp: { current: number; max: number };
  temporaryHP: number;
  conditions: ConditionName[];
  auras?: TokenAura[];
  
  // Combat
  initiative?: number;
  isCurrentTurn: boolean;
  
  // Visibility
  visibility: TokenVisibility;
  isHidden: boolean;
  
  // Selection
  isSelected: boolean;
  selectedBy?: string; // Player ID
  
  // Movement
  movementPath?: CharacterPosition[];
  movementRemaining?: number;
}

export interface TokenAura {
  radius: number; // In feet
  color: string;
  opacity: number;
  label?: string;
}

// ============================================================================
// MAP
// ============================================================================

export interface VTTMap {
  id: string;
  name: string;
  
  // Dimensions
  width: number;
  height: number;
  gridSize: number;
  
  // Background
  backgroundImageUrl?: string;
  backgroundColor: string;
  
  // Grid
  showGrid: boolean;
  gridColor: string;
  gridOpacity: number;
  gridStyle: 'square' | 'hex';
  
  // Fog of War
  fogEnabled: boolean;
  revealedCells: boolean[][];
  
  // Tokens
  tokens: VTTToken[];
  
  // Markers
  markers: VTTMarker[];
  
  // Drawing layer
  drawings: VTTDrawing[];
  
  // Lighting (optional)
  globalIllumination: 'bright' | 'dim' | 'dark';
  lightSources?: VTTLightSource[];
}

export interface VTTMarker {
  id: string;
  position: CharacterPosition;
  type: 'note' | 'ping' | 'arrow' | 'circle' | 'square';
  label?: string;
  color: string;
  dmOnly: boolean;
  createdBy: string;
  expiresAt?: Date;
}

export interface VTTDrawing {
  id: string;
  type: 'freehand' | 'line' | 'rectangle' | 'circle' | 'polygon';
  points: CharacterPosition[];
  color: string;
  fillColor?: string;
  lineWidth: number;
  dmOnly: boolean;
  createdBy: string;
}

export interface VTTLightSource {
  id: string;
  position: CharacterPosition;
  brightRadius: number;
  dimRadius: number;
  color: string;
  attachedToTokenId?: string;
}

// ============================================================================
// CHAT / ADVENTURE LOG
// ============================================================================

export type ChatMessageType =
  | 'narration'
  | 'dialogue'
  | 'player_action'
  | 'dice_roll'
  | 'combat_event'
  | 'system'
  | 'whisper'
  | 'emote';

export interface ChatMessage {
  id: string;
  type: ChatMessageType;
  
  // Sender
  senderId: string;
  senderName: string;
  senderType: 'dm' | 'player' | 'npc' | 'system';
  
  // Content
  content: string;
  
  // For rolls
  roll?: DiceRollResult;
  rollPurpose?: string;
  
  // For whispers
  recipientIds?: string[];
  
  // Metadata
  timestamp: Date;
  isPublic: boolean;
}

// ============================================================================
// INITIATIVE TRACKER
// ============================================================================

export interface VTTInitiativeTracker {
  isActive: boolean;
  round: number;
  entries: VTTInitiativeEntry[];
  currentIndex: number;
}

export interface VTTInitiativeEntry extends InitiativeEntry {
  tokenId: string;
  imageUrl?: string;
  currentHP?: number;
  maxHP?: number;
  conditions: ConditionName[];
}

// ============================================================================
// PLAYER STATE
// ============================================================================

export interface VTTPlayer {
  id: string;
  name: string;
  isDM: boolean;
  characterId?: string;
  characterName?: string;
  
  // Connection
  isConnected: boolean;
  lastSeen: Date;
  
  // UI State
  cursorPosition?: CharacterPosition;
  selectedTokenId?: string;
  viewportCenter?: CharacterPosition;
  viewportZoom?: number;
  
  // Permissions
  canMovePCs: boolean;
  canMoveNPCs: boolean;
  canRevealFog: boolean;
  canDrawOnMap: boolean;
}

// ============================================================================
// WEBSOCKET EVENTS
// ============================================================================

// Client -> Server
export interface VTTClientEvents {
  'join_session': { campaignId: string; playerId: string };
  'leave_session': { campaignId: string };
  
  'move_token': { tokenId: string; position: CharacterPosition; animate: boolean };
  'select_token': { tokenId: string | null };
  'update_token': { tokenId: string; updates: Partial<VTTToken> };
  
  'player_action': { action: string; targetIds?: string[]; details?: Record<string, unknown> };
  'roll_dice': { notation: string; purpose: string; advantage?: boolean; disadvantage?: boolean };
  
  'chat_message': { content: string; type: ChatMessageType; recipientIds?: string[] };
  
  'update_cursor': { position: CharacterPosition };
  'update_viewport': { center: CharacterPosition; zoom: number };
  
  'reveal_fog': { cells: CharacterPosition[] };
  'add_drawing': { drawing: Omit<VTTDrawing, 'id'> };
  'remove_drawing': { drawingId: string };
  'add_marker': { marker: Omit<VTTMarker, 'id'> };
  'remove_marker': { markerId: string };
  
  'end_turn': {};
  'delay_turn': {};
}

// Server -> Client
export interface VTTServerEvents {
  'session_state': { state: VTTSessionState };
  'player_joined': { player: VTTPlayer };
  'player_left': { playerId: string };
  
  'token_moved': { tokenId: string; position: CharacterPosition; animate: boolean };
  'token_updated': { tokenId: string; updates: Partial<VTTToken> };
  'token_added': { token: VTTToken };
  'token_removed': { tokenId: string };
  
  'roll_result': { playerId: string; playerName: string; result: DiceRollResult; purpose: string };
  
  'chat_message': { message: ChatMessage };
  
  'cursor_update': { playerId: string; position: CharacterPosition };
  
  'initiative_update': { tracker: VTTInitiativeTracker };
  'turn_started': { entityId: string; entityName: string };
  'combat_started': { initiativeOrder: VTTInitiativeEntry[] };
  'combat_ended': { outcome: string };
  
  'fog_revealed': { cells: CharacterPosition[] };
  'drawing_added': { drawing: VTTDrawing };
  'drawing_removed': { drawingId: string };
  'marker_added': { marker: VTTMarker };
  'marker_removed': { markerId: string };
  
  'map_changed': { map: VTTMap };
  'narration': { text: string; speaker: string; imageUrl?: string };
  
  'error': { message: string; code: string };
}

// ============================================================================
// SESSION STATE
// ============================================================================

export interface VTTSessionState {
  campaignId: string;
  sessionId: string;
  
  // Map
  currentMap: VTTMap;
  
  // Players
  players: VTTPlayer[];
  
  // Combat
  initiative?: VTTInitiativeTracker;
  
  // Chat
  recentMessages: ChatMessage[];
  
  // Game state
  gamePhase: 'exploration' | 'social' | 'combat' | 'rest';
  gameTime: string;
  
  // Party
  partyCharacters: {
    id: string;
    name: string;
    playerName: string;
    isAI: boolean;
    hp: { current: number; max: number };
    ac: number;
    conditions: ConditionName[];
  }[];
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Convert grid position to pixel position
 */
export function gridToPixel(
  gridPos: CharacterPosition,
  gridSize: number
): { x: number; y: number } {
  return {
    x: gridPos.x * gridSize + gridSize / 2,
    y: gridPos.y * gridSize + gridSize / 2,
  };
}

/**
 * Convert pixel position to grid position
 */
export function pixelToGrid(
  pixelX: number,
  pixelY: number,
  gridSize: number
): CharacterPosition {
  return {
    x: Math.floor(pixelX / gridSize),
    y: Math.floor(pixelY / gridSize),
  };
}

/**
 * Get cells occupied by a token
 */
export function getTokenCells(
  position: CharacterPosition,
  size: TokenSize
): CharacterPosition[] {
  const cellCount = TOKEN_SIZE_CELLS[size];
  const cells: CharacterPosition[] = [];
  
  if (cellCount < 1) {
    // Tiny creatures share a cell
    cells.push(position);
  } else {
    for (let dx = 0; dx < cellCount; dx++) {
      for (let dy = 0; dy < cellCount; dy++) {
        cells.push({ x: position.x + dx, y: position.y + dy });
      }
    }
  }
  
  return cells;
}

/**
 * Check if two tokens overlap
 */
export function tokensOverlap(
  token1: { position: CharacterPosition; size: TokenSize },
  token2: { position: CharacterPosition; size: TokenSize }
): boolean {
  const cells1 = getTokenCells(token1.position, token1.size);
  const cells2 = getTokenCells(token2.position, token2.size);
  
  for (const c1 of cells1) {
    for (const c2 of cells2) {
      if (c1.x === c2.x && c1.y === c2.y) {
        return true;
      }
    }
  }
  
  return false;
}
