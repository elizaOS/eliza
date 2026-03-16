/**
 * WebSocket Handler — real-time communication between client and game server
 */

import { Server as SocketIOServer, Socket } from 'socket.io';
import type { Server as HTTPServer } from 'http';
import type { GameState } from '../campaign';
import { processPlayerAction, getGameStatus } from '../campaign';
import { extractConditionNames, normalizeHP, buildCharacterPayload } from '../combat/condition-utils';

interface ClientData {
  campaignId?: string;
  characterId?: string;
  characterName?: string;
}

const clients = new Map<string, ClientData>();

function buildCombatState(state: GameState) {
  const combat = state.combatEncounter;
  if (!combat) return null;
  return {
    round: combat.round,
    currentTurnIndex: combat.currentTurnIndex,
    combatants: combat.initiativeOrder.map((c, i) => ({
      id: c.id, name: c.name, type: c.type, initiative: c.initiative,
      hp: c.hp, ac: c.ac,
      conditions: extractConditionNames(c.conditions),
      isCurrentTurn: i === combat.currentTurnIndex,
    })),
  };
}

function buildCharacterInfo(state: GameState, characterId: string) {
  const character = state._characters?.find(c => c.id === characterId);
  return character ? buildCharacterPayload(character) : null;
}

export function initializeWebSocket(httpServer: HTTPServer, gameState: GameState): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.CLIENT_ORIGIN || 'http://localhost:3000',
      methods: ['GET', 'POST'],
    },
  });

  io.on('connection', (socket: Socket) => {
    console.log(`Client connected: ${socket.id}`);
    clients.set(socket.id, {});
    socket.emit('game_status', getGameStatus(gameState));

    socket.on('join_campaign', ({ campaignId, characterId }: { campaignId: string; characterId?: string }) => {
      const client = clients.get(socket.id);
      if (!client) return;

      client.campaignId = campaignId;
      client.characterId = characterId;
      if (characterId) {
        client.characterName = gameState._characters?.find(c => c.id === characterId)?.name ?? 'Adventurer';
      }

      socket.join(`campaign:${campaignId}`);
      if (characterId) socket.join(`character:${characterId}`);

      socket.emit('phase_change', { phase: gameState.phase });
      if (characterId) {
        const charInfo = buildCharacterInfo(gameState, characterId);
        if (charInfo) socket.emit('character_update', charInfo);
      }
      const combat = buildCombatState(gameState);
      if (combat) socket.emit('combat_update', combat);

      socket.emit('join_confirmed', {
        campaignId, characterId,
        characterName: client.characterName,
        phase: gameState.phase,
      });

      // Send opening narration on first join if available
      if (gameState._openingNarration) {
        socket.emit('dm_narration', { content: gameState._openingNarration });
        gameState._openingNarration = undefined; // Only send once
      }
    });

    socket.on('player_message', async ({ message }: { message: string; characterId?: string }) => {
      const client = clients.get(socket.id);
      const characterId = client?.characterId;
      if (!characterId || !gameState.sessionState) {
        return socket.emit('error', { message: 'Not in an active session. Join a campaign first.' });
      }

      try {
        const result = await processPlayerAction(gameState, characterId, { type: 'message', description: message });
        socket.emit('action_result', result);
        if (client?.campaignId) {
          io.to(`campaign:${client.campaignId}`).emit('player_action', {
            characterName: client.characterName ?? 'Player',
            content: message,
          });
        }
      } catch (error) {
        console.error('Error processing player message:', error);
        socket.emit('error', { message: 'Failed to process message.' });
      }
    });

    socket.on('player_action', async (data: { action: string; target?: string; characterId?: string; [key: string]: unknown }) => {
      const client = clients.get(socket.id);
      const characterId = client?.characterId;
      if (!characterId || !gameState.sessionState) {
        return socket.emit('error', { message: 'Not in an active session. Join a campaign first.' });
      }

      try {
        const result = await processPlayerAction(gameState, characterId, {
          type: data.action, description: data.action,
          target: data.target, metadata: data,
        });
        socket.emit('action_result', result);

        if (client?.campaignId) {
          io.to(`campaign:${client.campaignId}`).emit('player_action', {
            characterName: client.characterName ?? 'Player',
            content: result.response,
          });
          const combat = buildCombatState(gameState);
          if (combat) io.to(`campaign:${client.campaignId}`).emit('combat_update', combat);
        }
      } catch (error) {
        console.error('Error processing player action:', error);
        socket.emit('error', { message: 'Failed to process action.' });
      }
    });

    socket.on('move_token', ({ id, x, y }: { id: string; x: number; y: number }) => {
      const client = clients.get(socket.id);
      if (client?.campaignId) {
        socket.to(`campaign:${client.campaignId}`).emit('token_moved', { id, x, y });
      }
    });

    socket.on('request_state', () => {
      socket.emit('game_status', getGameStatus(gameState));
      const client = clients.get(socket.id);
      if (client?.characterId) {
        const charInfo = buildCharacterInfo(gameState, client.characterId);
        if (charInfo) socket.emit('character_update', charInfo);
      }
      const combat = buildCombatState(gameState);
      if (combat) socket.emit('combat_update', combat);
    });

    socket.on('disconnect', () => {
      console.log(`Client disconnected: ${socket.id}`);
      clients.delete(socket.id);
    });
  });

  return io;
}

export function broadcastNarration(io: SocketIOServer, campaignId: string, content: string): void {
  io.to(`campaign:${campaignId}`).emit('dm_narration', { content });
}

export function broadcastPhaseChange(io: SocketIOServer, campaignId: string, phase: string): void {
  io.to(`campaign:${campaignId}`).emit('phase_change', { phase });
}

export function broadcastCombatUpdate(
  io: SocketIOServer, campaignId: string,
  data: { round: number; combatants: unknown[]; currentTurnIndex: number },
): void {
  io.to(`campaign:${campaignId}`).emit('combat_update', data);
}

export function sendCharacterUpdate(io: SocketIOServer, characterId: string, data: unknown): void {
  io.to(`character:${characterId}`).emit('character_update', data);
}

export function broadcastCombatAction(
  io: SocketIOServer, campaignId: string,
  action: { actorName: string; description: string; damage?: number; healing?: number },
): void {
  io.to(`campaign:${campaignId}`).emit('combat_action', action);
}
