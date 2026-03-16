/**
 * Movement Rules
 * D&D 5e movement, difficult terrain, and positioning
 */

import {
  type CharacterSheet,
  type Monster,
  type ActiveCondition,
  normalizeCondition,
  getConditionName,
} from '../types';

export interface Position {
  x: number;
  y: number;
}

export interface MovementParams {
  creature: CharacterSheet | Monster;
  creatureType: 'character' | 'monster';
  from: Position;
  to: Position;
  gridSize?: number; // feet per grid square, default 5
  activeConditions?: ActiveCondition[];
  terrainCosts?: Map<string, number>; // position key -> movement cost multiplier
  allowDiagonal?: boolean;
}

export interface MovementResult {
  canMove: boolean;
  distanceMoved: number;
  movementCost: number;
  remainingMovement: number;
  path: Position[];
  triggeredOpportunityAttacks: Position[];
  description: string;
}

export interface CreatureSpeed {
  walk: number;
  fly?: number;
  swim?: number;
  climb?: number;
  burrow?: number;
}

/**
 * Get base movement speed for a creature
 */
export function getBaseSpeed(
  creature: CharacterSheet | Monster,
  creatureType: 'character' | 'monster'
): CreatureSpeed {
  if (creatureType === 'monster') {
    const monster = creature as Monster;
    return {
      walk: monster.speed.walk || 30,
      fly: monster.speed.fly,
      swim: monster.speed.swim,
      climb: monster.speed.climb,
      burrow: monster.speed.burrow,
    };
  }
  
  const character = creature as CharacterSheet;
  return {
    walk: character.speed || 30,
    fly: undefined,
    swim: undefined,
    climb: undefined,
    burrow: undefined,
  };
}

/**
 * Apply condition modifiers to speed
 */
export function getModifiedSpeed(
  baseSpeed: CreatureSpeed,
  activeConditions: ActiveCondition[]
): CreatureSpeed {
  let walkSpeed = baseSpeed.walk;
  let canMove = true;
  
  for (const active of activeConditions) {
    const condName = normalizeCondition(getConditionName(active));
    
    // Grappled, Restrained - speed becomes 0
    if (condName === 'grappled' || condName === 'restrained') {
      walkSpeed = 0;
    }
    
    // Prone - speed costs double (handled in movement calculation)
    // Also can't benefit from fly speed while prone
    
    // Paralyzed, Petrified, Stunned, Unconscious - speed 0
    if (['paralyzed', 'petrified', 'stunned', 'unconscious'].includes(condName)) {
      walkSpeed = 0;
      canMove = false;
    }
    
    // Exhaustion effects
    if (condName === 'exhaustion') {
      const level = active.exhaustionLevel ?? active.level ?? 1;
      if (level >= 5) {
        walkSpeed = 0;
        canMove = false;
      } else if (level >= 2) {
        walkSpeed = Math.floor(walkSpeed / 2);
      }
    }
  }
  
  return {
    walk: walkSpeed,
    fly: canMove ? baseSpeed.fly : undefined,
    swim: canMove ? baseSpeed.swim : undefined,
    climb: canMove ? baseSpeed.climb : undefined,
    burrow: canMove ? baseSpeed.burrow : undefined,
  };
}

/**
 * Calculate distance between two positions in feet
 */
export function calculateDistance(
  from: Position,
  to: Position,
  gridSize: number = 5,
  useDiagonalVariant: boolean = false
): number {
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  
  if (!useDiagonalVariant) {
    // Standard: every diagonal is 5 ft (Euclidean approximation)
    return Math.max(dx, dy) * gridSize;
  }
  
  // Variant: every other diagonal costs 10 ft
  const diagonals = Math.min(dx, dy);
  const straights = Math.abs(dx - dy);
  
  // First diagonal is 5ft, second is 10ft, etc.
  const diagonalCost = Math.floor(diagonals / 2) * 15 + (diagonals % 2) * 5;
  const straightCost = straights * gridSize;
  
  return diagonalCost + straightCost;
}

/**
 * Generate a path from start to end (simple A* pathfinding)
 */
export function findPath(
  from: Position,
  to: Position,
  blockedCells: Set<string>,
  maxRange: number,
  gridSize: number = 5
): Position[] {
  // Simple implementation - more complex pathfinding can be added
  const path: Position[] = [];
  let current = { ...from };
  
  // Simple greedy approach for basic movement
  while (current.x !== to.x || current.y !== to.y) {
    const dx = Math.sign(to.x - current.x);
    const dy = Math.sign(to.y - current.y);
    
    // Try to move diagonally first, then cardinal
    const candidates: Position[] = [];
    
    if (dx !== 0 && dy !== 0) {
      candidates.push({ x: current.x + dx, y: current.y + dy });
    }
    if (dx !== 0) {
      candidates.push({ x: current.x + dx, y: current.y });
    }
    if (dy !== 0) {
      candidates.push({ x: current.x, y: current.y + dy });
    }
    
    let moved = false;
    for (const candidate of candidates) {
      const key = `${candidate.x},${candidate.y}`;
      if (!blockedCells.has(key)) {
        path.push(candidate);
        current = candidate;
        moved = true;
        break;
      }
    }
    
    if (!moved) {
      // Path is blocked
      break;
    }
    
    // Check if we've exceeded movement range
    const distanceSoFar = calculateDistance(from, current, gridSize);
    if (distanceSoFar > maxRange) {
      path.pop(); // Remove the last position that exceeded range
      break;
    }
  }
  
  return path;
}

/**
 * Check if a position is adjacent (within 5 feet)
 */
export function isAdjacent(pos1: Position, pos2: Position): boolean {
  const dx = Math.abs(pos1.x - pos2.x);
  const dy = Math.abs(pos1.y - pos2.y);
  return dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0);
}

/**
 * Get all adjacent positions
 */
export function getAdjacentPositions(pos: Position): Position[] {
  const adjacent: Position[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx !== 0 || dy !== 0) {
        adjacent.push({ x: pos.x + dx, y: pos.y + dy });
      }
    }
  }
  return adjacent;
}

/**
 * Determine which enemies could make opportunity attacks
 */
export function getOpportunityAttackTriggers(
  path: Position[],
  enemyPositions: Position[],
  startPosition: Position
): Position[] {
  // Opportunity attacks trigger when leaving an enemy's reach without Disengage
  const threats: Position[] = [];
  const previousPosition = startPosition;
  
  // Check if any path position takes us out of an enemy's reach
  for (const step of path) {
    for (const enemy of enemyPositions) {
      const wasAdjacent = isAdjacent(previousPosition, enemy);
      const isStillAdjacent = isAdjacent(step, enemy);
      
      if (wasAdjacent && !isStillAdjacent) {
        threats.push(enemy);
      }
    }
  }
  
  return threats;
}

/**
 * Calculate terrain movement cost
 */
export function getTerrainCost(
  position: Position,
  terrainCosts: Map<string, number>
): number {
  const key = `${position.x},${position.y}`;
  return terrainCosts.get(key) || 1;
}

/**
 * Standing up from prone
 */
export function standUpCost(currentSpeed: number): number {
  // Standing up costs half your movement
  return Math.floor(currentSpeed / 2);
}

/**
 * Check if creature can stand up
 */
export function canStandUp(
  movementRemaining: number,
  currentSpeed: number
): boolean {
  return movementRemaining >= standUpCost(currentSpeed);
}

/**
 * Calculate movement with difficult terrain and conditions
 */
export function calculateMovement(params: MovementParams): MovementResult {
  const {
    creature,
    creatureType,
    from,
    to,
    gridSize = 5,
    activeConditions = [],
    terrainCosts = new Map(),
    allowDiagonal = true,
  } = params;
  
  const baseSpeed = getBaseSpeed(creature, creatureType);
  const modifiedSpeed = getModifiedSpeed(baseSpeed, activeConditions);
  
  // Check if movement is possible
  if (modifiedSpeed.walk <= 0) {
    const name = creatureType === 'character' 
      ? (creature as CharacterSheet).name 
      : (creature as Monster).name;
    
    return {
      canMove: false,
      distanceMoved: 0,
      movementCost: 0,
      remainingMovement: 0,
      path: [],
      triggeredOpportunityAttacks: [],
      description: `${name} cannot move due to their current condition.`,
    };
  }
  
  // Check if prone (movement costs double)
  const isProne = activeConditions.some(c => normalizeCondition(getConditionName(c)) === 'prone');
  const speedMultiplier = isProne ? 0.5 : 1;
  const effectiveSpeed = Math.floor(modifiedSpeed.walk * speedMultiplier);
  
  // Calculate raw distance
  const rawDistance = calculateDistance(from, to, gridSize, false);
  
  // Simple path for now (straight line approximation)
  const path: Position[] = [];
  let movementCost = 0;
  
  // Build path step by step
  let current = { ...from };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  
  for (let i = 1; i <= steps && movementCost < effectiveSpeed; i++) {
    const nextX = from.x + Math.round((dx * i) / steps);
    const nextY = from.y + Math.round((dy * i) / steps);
    const next = { x: nextX, y: nextY };
    
    // Calculate cost for this step
    const terrainMult = getTerrainCost(next, terrainCosts);
    const stepCost = gridSize * terrainMult;
    
    if (movementCost + stepCost <= effectiveSpeed) {
      path.push(next);
      current = next;
      movementCost += stepCost;
    } else {
      break;
    }
  }
  
  const distanceMoved = calculateDistance(from, current, gridSize);
  const remainingMovement = Math.max(0, effectiveSpeed - movementCost);
  
  const name = creatureType === 'character'
    ? (creature as CharacterSheet).name
    : (creature as Monster).name;
  
  const reachedDestination = current.x === to.x && current.y === to.y;
  let description = `${name} moves ${distanceMoved} feet`;
  
  if (!reachedDestination) {
    description += ` (${remainingMovement} feet remaining)`;
  }
  
  if (isProne) {
    description += ' (speed halved while prone)';
  }
  
  return {
    canMove: true,
    distanceMoved,
    movementCost,
    remainingMovement,
    path,
    triggeredOpportunityAttacks: [], // Caller should check with enemy positions
    description,
  };
}

/**
 * Special movement types
 */
export const MOVEMENT_ACTIONS = {
  // Dash: double movement for the turn
  dash: (baseSpeed: number) => baseSpeed * 2,
  
  // Disengage: no opportunity attacks this turn
  disengage: () => true,
  
  // Dodge: attacks against have disadvantage
  dodge: () => true,
  
  // Jump (running long jump): Strength score in feet
  longJump: (strengthScore: number) => strengthScore,
  
  // Standing long jump: half distance
  standingLongJump: (strengthScore: number) => Math.floor(strengthScore / 2),
  
  // High jump: 3 + Strength modifier feet
  highJump: (strengthMod: number) => 3 + strengthMod,
  
  // Standing high jump: half distance
  standingHighJump: (strengthMod: number) => Math.floor((3 + strengthMod) / 2),
} as const;
