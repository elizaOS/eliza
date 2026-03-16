import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';

export type GamePhase = 'initializing' | 'narration' | 'exploration' | 'social' | 'combat' | 'rest';

export interface Token {
  id: string;
  name: string;
  type: 'pc' | 'npc' | 'monster';
  x: number;
  y: number;
  size: number;
  imageUrl?: string;
  hp?: { current: number; max: number };
  conditions?: string[];
}

export interface Combatant {
  id: string;
  name: string;
  type: 'pc' | 'npc' | 'monster';
  initiative: number;
  hp: { current: number; max: number; temp: number };
  ac: number;
  conditions: string[];
  isCurrentTurn: boolean;
}

export interface LogEntry {
  id: string;
  timestamp: Date;
  type: 'narrative' | 'action' | 'roll' | 'system' | 'combat' | 'error';
  speaker?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface CharacterInfo {
  id: string;
  name: string;
  race: string;
  class: string;
  level: number;
  hp: { current: number; max: number; temp: number };
  ac: number;
  speed: number;
  conditions: string[];
  spellSlots?: Record<number, { current: number; max: number }>;
}

interface GameState {
  // Connection
  connected: boolean;
  socket: Socket | null;
  
  // Join state
  joined: boolean;
  campaignId: string | null;
  
  // Game state
  phase: GamePhase;
  inCombat: boolean;
  round: number;
  
  // Map
  tokens: Token[];
  selectedTokenId: string | null;
  mapWidth: number;
  mapHeight: number;
  gridSize: number;
  mapImageUrl: string | null;
  
  // Combat
  combatants: Combatant[];
  currentTurnIndex: number;
  
  // Log & character
  log: LogEntry[];
  character: CharacterInfo | null;
  
  // Actions
  connect: () => void;
  disconnect: () => void;
  joinCampaign: (campaignId: string, characterId?: string) => void;
  selectToken: (id: string | null) => void;
  moveToken: (id: string, x: number, y: number) => void;
  sendAction: (action: string, data?: Record<string, unknown>) => void;
  sendMessage: (message: string) => void;
  addLogEntry: (entry: Omit<LogEntry, 'id' | 'timestamp'>) => void;
  setPhase: (phase: GamePhase) => void;
  setCombatants: (combatants: Combatant[]) => void;
  setTokens: (tokens: Token[]) => void;
  setCharacter: (character: CharacterInfo | null) => void;
}

const createLogEntry = (entry: Omit<LogEntry, 'id' | 'timestamp'>): LogEntry => ({
  ...entry,
  id: crypto.randomUUID(),
  timestamp: new Date(),
});

const SERVER_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export const useGameStore = create<GameState>((set, get) => ({
  connected: false,
  socket: null,
  joined: false,
  campaignId: null,
  phase: 'initializing',
  inCombat: false,
  round: 0,
  tokens: [],
  selectedTokenId: null,
  mapWidth: 30,
  mapHeight: 20,
  gridSize: 40,
  mapImageUrl: null,
  combatants: [],
  currentTurnIndex: 0,
  log: [],
  character: null,

  connect: () => {
    const socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });
    
    socket.on('connect', () => {
      set({ connected: true, socket });
      get().addLogEntry({ type: 'system', content: 'Connected to the game server.' });
    });
    
    socket.on('disconnect', () => {
      set({ connected: false });
      get().addLogEntry({ type: 'system', content: 'Disconnected from the game server.' });
    });
    
    socket.on('game_status', ({ phase, inCombat, currentTurn, roundNumber }: { 
      phase: GamePhase;
      inCombat: boolean;
      currentTurn: string | null;
      roundNumber: number;
    }) => {
      set({ phase, inCombat, round: roundNumber });
      if (currentTurn) {
        get().addLogEntry({ type: 'system', content: `Current turn: ${currentTurn}` });
      }
    });
    
    socket.on('join_confirmed', ({ campaignId, characterName, phase }: {
      campaignId: string;
      characterId?: string;
      characterName?: string;
      phase: GamePhase;
    }) => {
      set({ joined: true, campaignId, phase, inCombat: phase === 'combat' });
      const msg = characterName
        ? `Joined campaign as ${characterName}.`
        : 'Joined campaign as spectator.';
      get().addLogEntry({ type: 'system', content: msg });
    });
    
    socket.on('phase_change', ({ phase }: { phase: GamePhase }) => {
      set({ phase, inCombat: phase === 'combat' });
    });
    
    socket.on('combat_update', ({ round, combatants, currentTurnIndex }: { 
      round: number; 
      combatants: Combatant[];
      currentTurnIndex: number;
    }) => {
      set({ round, combatants, currentTurnIndex, inCombat: true });
    });
    
    socket.on('combat_end', () => {
      set({ inCombat: false, combatants: [], round: 0 });
      get().addLogEntry({ type: 'system', content: 'Combat has ended.' });
    });
    
    socket.on('tokens_update', (tokens: Token[]) => set({ tokens }));
    socket.on('token_moved', ({ id, x, y }: { id: string; x: number; y: number }) => {
      set(state => ({
        tokens: state.tokens.map(t => t.id === id ? { ...t, x, y } : t),
      }));
    });
    socket.on('character_update', (character: CharacterInfo) => set({ character }));
    
    socket.on('dm_narration', ({ content }: { content: string }) => {
      get().addLogEntry({ type: 'narrative', speaker: 'Dungeon Master', content });
    });
    
    socket.on('player_action', ({ characterName, content, rollResult }: { 
      characterName: string; 
      content: string;
      rollResult?: { total: number; type: string };
    }) => {
      get().addLogEntry({
        type: rollResult ? 'roll' : 'action',
        speaker: characterName,
        content,
        metadata: rollResult ? { roll: rollResult } : undefined,
      });
    });
    
    socket.on('combat_action', ({ actorName, description, damage, healing }: {
      actorName: string;
      description: string;
      damage?: number;
      healing?: number;
    }) => {
      get().addLogEntry({
        type: 'combat',
        speaker: actorName,
        content: description,
        metadata: { damage, healing },
      });
    });
    
    socket.on('action_result', ({ success, response }: { success: boolean; response: string }) => {
      if (!success) {
        get().addLogEntry({ type: 'error', content: response });
      }
    });
    
    socket.on('error', ({ message }: { message: string }) => {
      get().addLogEntry({ type: 'error', content: `Error: ${message}` });
    });
    
    set({ socket });
  },

  disconnect: () => {
    get().socket?.disconnect();
    set({ socket: null, connected: false, joined: false, campaignId: null });
  },

  joinCampaign: (campaignId: string, characterId?: string) => {
    const { socket } = get();
    if (!socket) return;
    
    socket.emit('join_campaign', { campaignId, characterId });
  },

  selectToken: (id) => set({ selectedTokenId: id }),

  moveToken: (id, x, y) => {
    const { socket, tokens } = get();
    set({ tokens: tokens.map(t => t.id === id ? { ...t, x, y } : t) });
    socket?.emit('move_token', { id, x, y });
  },

  sendAction: (action, data) => {
    get().socket?.emit('player_action', { action, ...data });
  },

  sendMessage: (message) => {
    const { socket, character } = get();
    socket?.emit('player_message', { message, characterId: character?.id });
    if (character) {
      get().addLogEntry({ type: 'action', speaker: character.name, content: message });
    }
  },

  addLogEntry: (entry) => {
    set(state => ({
      log: [...state.log.slice(-99), createLogEntry(entry)],
    }));
  },

  setPhase: (phase) => set({ phase, inCombat: phase === 'combat' }),
  setCombatants: (combatants) => set({ combatants }),
  setTokens: (tokens) => set({ tokens }),
  setCharacter: (character) => set({ character }),
}));
