/**
 * Pacing Evaluator
 * Monitors game pacing and suggests adjustments
 */

import type { Evaluator, IAgentRuntime, Memory, State } from '@elizaos/core';

export type GamePhase = 'exploration' | 'social' | 'combat' | 'puzzle' | 'rest' | 'travel';

export interface PacingMetrics {
  currentPhase: GamePhase;
  phaseStartTime: Date;
  phaseDurationMinutes: number;
  turnsInPhase: number;
  suggestedAction: 'continue' | 'transition' | 'introduce_conflict' | 'allow_rest' | 'advance_plot';
  reasoning: string;
}

// Target durations for each phase (in minutes)
const PHASE_TARGETS: Record<GamePhase, { min: number; ideal: number; max: number }> = {
  exploration: { min: 5, ideal: 15, max: 30 },
  social: { min: 5, ideal: 20, max: 40 },
  combat: { min: 10, ideal: 30, max: 60 },
  puzzle: { min: 5, ideal: 15, max: 30 },
  rest: { min: 2, ideal: 5, max: 10 },
  travel: { min: 2, ideal: 10, max: 20 },
};

interface PacingState {
  currentPhase: GamePhase;
  phaseStartTime: string;
  turnCount: number;
  phaseHistory: Array<{ phase: GamePhase; duration: number }>;
}

export const pacingEvaluator: Evaluator = {
  name: 'pacing',
  description: 'Monitors game pacing and suggests adjustments',
  
  alwaysRun: true, // Run on every DM turn
  
  similes: [
    'check pacing',
    'game flow',
    'session rhythm',
    'time management',
  ],
  
  examples: [
    {
      prompt: 'Combat has been going on for 45 minutes',
      messages: [],
      outcome: 'Suggest wrapping up combat soon or introducing a dramatic end.',
    },
    {
      prompt: 'Players have been shopping for 30 minutes',
      messages: [],
      outcome: 'Suggest introducing an event to move the story forward.',
    },
  ],
  
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const role = await runtime.getSetting('role');
    return role === 'dm';
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ) => {
    // Get current pacing state
    const raw = runtime.getSetting('pacingState');
    let pacingState: PacingState | null = null;
    if (raw && typeof raw === 'string') {
      try {
        pacingState = JSON.parse(raw) as PacingState;
      } catch {
        pacingState = null;
      }
    }
    
    if (!pacingState) {
      // Initialize pacing state
      const initialState: PacingState = {
        currentPhase: 'exploration',
        phaseStartTime: new Date().toISOString(),
        turnCount: 1,
        phaseHistory: [],
      };
      runtime.setSetting('pacingState', JSON.stringify(initialState));
      
      return {
        success: true,
        data: {
          metrics: {
            currentPhase: 'exploration',
            phaseStartTime: new Date(),
            phaseDurationMinutes: 0,
            turnsInPhase: 1,
            suggestedAction: 'continue',
            reasoning: 'Session just started - establishing the scene.',
          } satisfies PacingMetrics,
        },
      };
    }
    
    // Calculate phase duration
    const phaseStart = new Date(pacingState.phaseStartTime);
    const now = new Date();
    const durationMs = now.getTime() - phaseStart.getTime();
    const durationMinutes = Math.round(durationMs / 60000);
    
    const currentPhase = pacingState.currentPhase;
    const targets = PHASE_TARGETS[currentPhase];
    
    // Determine the current turn count in this phase
    const turnCount = pacingState.turnCount + 1;
    
    // Analyze pacing
    let suggestedAction: PacingMetrics['suggestedAction'] = 'continue';
    let reasoning = '';
    
    if (durationMinutes < targets.min) {
      suggestedAction = 'continue';
      reasoning = `${currentPhase} phase is still young (${durationMinutes}/${targets.ideal} min). Continue developing the scene.`;
    } else if (durationMinutes >= targets.min && durationMinutes <= targets.ideal) {
      suggestedAction = 'continue';
      reasoning = `Good pacing for ${currentPhase} phase (${durationMinutes}/${targets.ideal} min). Scene is developing well.`;
    } else if (durationMinutes > targets.ideal && durationMinutes <= targets.max) {
      // Consider transitioning based on recent activity
      if (currentPhase === 'combat') {
        suggestedAction = 'introduce_conflict';
        reasoning = `Combat at ${durationMinutes} min. Consider introducing a twist or working toward resolution.`;
      } else if (currentPhase === 'social') {
        suggestedAction = 'transition';
        reasoning = `Social scene at ${durationMinutes} min. Consider natural transition to next scene.`;
      } else {
        suggestedAction = 'advance_plot';
        reasoning = `${currentPhase} phase at ${durationMinutes} min. Good time to advance the main plot.`;
      }
    } else {
      // Phase is running long
      if (currentPhase === 'combat') {
        suggestedAction = 'transition';
        reasoning = `Combat has been running ${durationMinutes} min (max: ${targets.max}). Strongly consider ending the encounter.`;
      } else if (currentPhase === 'social' || currentPhase === 'exploration') {
        suggestedAction = 'introduce_conflict';
        reasoning = `${currentPhase} phase at ${durationMinutes} min is running long. Inject some dramatic tension.`;
      } else {
        suggestedAction = 'transition';
        reasoning = `${currentPhase} phase at ${durationMinutes} min exceeds ideal. Time to move forward.`;
      }
    }
    
    // Check phase variety
    const recentPhases = pacingState.phaseHistory.slice(-3).map(p => p.phase);
    if (recentPhases.length >= 2 && recentPhases.every(p => p === currentPhase)) {
      if (suggestedAction === 'continue') {
        suggestedAction = 'transition';
        reasoning += ' Note: Consider varying the gameplay type for better engagement.';
      }
    }
    
    // Update pacing state
    runtime.setSetting('pacingState', JSON.stringify({
      ...pacingState,
      turnCount,
    }));
    
    const metrics: PacingMetrics = {
      currentPhase,
      phaseStartTime: phaseStart,
      phaseDurationMinutes: durationMinutes,
      turnsInPhase: turnCount,
      suggestedAction,
      reasoning,
    };
    
    // Emit warning if pacing is significantly off
    if (durationMinutes > targets.max * 1.5) {
      const warningPayload = {
        runtime,
        phase: currentPhase,
        duration: durationMinutes,
        recommendation: suggestedAction,
        timestamp: new Date(),
      };
      await runtime.emitEvent('pacing_warning', warningPayload);
    }
    
    return {
      success: true,
      data: { metrics },
    };
  },
};

/**
 * Utility function to transition to a new game phase
 */
export async function transitionPhase(
  runtime: IAgentRuntime,
  newPhase: GamePhase
): Promise<void> {
  const raw = runtime.getSetting('pacingState');
  let pacingState: PacingState | null = null;
  if (raw && typeof raw === 'string') {
    try {
      pacingState = JSON.parse(raw) as PacingState;
    } catch {
      pacingState = null;
    }
  }
  
  if (pacingState) {
    const phaseStart = new Date(pacingState.phaseStartTime);
    const duration = Math.round((new Date().getTime() - phaseStart.getTime()) / 60000);
    
    // Record the ended phase
    const phaseHistory = [
      ...pacingState.phaseHistory,
      { phase: pacingState.currentPhase, duration },
    ].slice(-10); // Keep last 10 phases
    
    // Start new phase
    runtime.setSetting('pacingState', JSON.stringify({
      currentPhase: newPhase,
      phaseStartTime: new Date().toISOString(),
      turnCount: 0,
      phaseHistory,
    }));
    
    const transitionPayload = {
      runtime,
      fromPhase: pacingState.currentPhase,
      toPhase: newPhase,
      previousDuration: duration,
      timestamp: new Date(),
    };
    await runtime.emitEvent('phase_transition', transitionPayload);
  }
}

export default pacingEvaluator;
