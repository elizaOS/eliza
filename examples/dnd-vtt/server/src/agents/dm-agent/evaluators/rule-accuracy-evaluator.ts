/**
 * Rule Accuracy Evaluator
 * Checks that D&D 5e rules are being applied correctly
 */

import type { Evaluator, IAgentRuntime, Memory, State } from '@elizaos/core';

export interface RuleCheckResult {
  isValid: boolean;
  ruleCategory: string;
  details: string;
  suggestedCorrection?: string;
}

export interface RuleAccuracyMetrics {
  checksPerformed: number;
  correctApplications: number;
  errors: RuleCheckResult[];
  accuracy: number; // 0-100 percentage
}

export const ruleAccuracyEvaluator: Evaluator = {
  name: 'ruleAccuracy',
  description: 'Validates that D&D 5e rules are being applied correctly',
  
  alwaysRun: false,
  
  similes: [
    'check rules',
    'verify mechanics',
    'validate roll',
    'confirm damage',
  ],
  
  examples: [
    {
      prompt: 'DM resolved an attack roll',
      messages: [
        {
          name: 'dm',
          content: {
            text: 'The fighter rolls a 15, adding their +7 modifier for a total of 22.',
          },
        },
      ],
      outcome: 'Valid - math checks out (15 + 7 = 22)',
    },
    {
      prompt: 'DM applied damage incorrectly',
      messages: [
        {
          name: 'dm',
          content: {
            text: 'The goblin takes 2d6+3 slashing damage... that\'s 15 damage!',
          },
        },
      ],
      outcome: 'Invalid - damage calculation error. 4 + 3 + 3 = 10, not 15',
    },
  ],
  
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Validate mechanical resolutions
    const content = message.content as Record<string, unknown> | undefined;
    const metadata = content?.metadata as Record<string, unknown> | undefined;
    return Boolean(
      metadata?.rollType ||
      metadata?.damageRoll ||
      metadata?.savingThrow ||
      metadata?.abilityCheck
    );
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ) => {
    const metadata = message.content?.metadata as Record<string, unknown> | undefined;
    
    if (!metadata) {
      return undefined;
    }
    
    const checks: RuleCheckResult[] = [];
    
    // Check attack roll math
    if (metadata.rollType === 'attack' && metadata.baseRoll !== undefined) {
      checks.push(checkAttackRoll(metadata));
    }
    
    // Check damage calculations
    if (metadata.damageRoll && metadata.diceResults) {
      checks.push(checkDamageCalculation(metadata));
    }
    
    // Check saving throw validity
    if (metadata.savingThrow) {
      checks.push(checkSavingThrow(metadata));
    }
    
    // Check ability check
    if (metadata.abilityCheck) {
      checks.push(checkAbilityCheck(metadata));
    }
    
    // Check DC validity
    if (metadata.dc !== undefined) {
      checks.push(checkDC(metadata));
    }
    
    // Compile metrics
    const errors = checks.filter(c => !c.isValid);
    const metrics: RuleAccuracyMetrics = {
      checksPerformed: checks.length,
      correctApplications: checks.length - errors.length,
      errors,
      accuracy: checks.length > 0 
        ? Math.round(((checks.length - errors.length) / checks.length) * 100)
        : 100,
    };
    
    // Log errors for review
    if (errors.length > 0) {
      console.warn('Rule accuracy issues detected:', errors);
      
      // Emit event for potential correction
      const errorPayload = {
        runtime,
        errors,
        messageId: message.id,
        timestamp: new Date(),
      };
      await runtime.emitEvent('rule_error_detected', errorPayload);
    }
    
    // Track metrics over time
    const raw = runtime.getSetting('ruleAccuracyHistory');
    let history: RuleAccuracyMetrics[] = [];
    if (raw && typeof raw === 'string') {
      try {
        history = JSON.parse(raw) as RuleAccuracyMetrics[];
      } catch {
        history = [];
      }
    }
    history.push(metrics);
    
    if (history.length > 100) {
      history.shift();
    }
    
    runtime.setSetting('ruleAccuracyHistory', JSON.stringify(history));
    
    return {
      success: true,
      data: { metrics },
    };
  },
};

function checkAttackRoll(metadata: Record<string, unknown>): RuleCheckResult {
  const baseRoll = metadata.baseRoll as number;
  const modifier = metadata.modifier as number || 0;
  const total = metadata.total as number;
  const expected = baseRoll + modifier;
  
  return {
    isValid: total === expected,
    ruleCategory: 'Attack Roll',
    details: `Base ${baseRoll} + modifier ${modifier} = ${expected}`,
    suggestedCorrection: total !== expected 
      ? `Total should be ${expected}, not ${total}`
      : undefined,
  };
}

function checkDamageCalculation(metadata: Record<string, unknown>): RuleCheckResult {
  const diceResults = metadata.diceResults as number[];
  const modifier = metadata.modifier as number || 0;
  const total = metadata.total as number;
  const diceSum = diceResults.reduce((a, b) => a + b, 0);
  const expected = diceSum + modifier;
  
  return {
    isValid: total === expected,
    ruleCategory: 'Damage Calculation',
    details: `Dice (${diceResults.join(' + ')}) + modifier ${modifier} = ${expected}`,
    suggestedCorrection: total !== expected
      ? `Damage should be ${expected}, not ${total}`
      : undefined,
  };
}

function checkSavingThrow(metadata: Record<string, unknown>): RuleCheckResult {
  const save = metadata.savingThrow as { ability: string; dc: number; roll: number; modifier: number; success: boolean };
  const total = save.roll + save.modifier;
  const expectedSuccess = total >= save.dc;
  
  return {
    isValid: save.success === expectedSuccess,
    ruleCategory: 'Saving Throw',
    details: `${save.ability} save: ${save.roll} + ${save.modifier} = ${total} vs DC ${save.dc}`,
    suggestedCorrection: save.success !== expectedSuccess
      ? `Should be ${expectedSuccess ? 'success' : 'failure'}`
      : undefined,
  };
}

function checkAbilityCheck(metadata: Record<string, unknown>): RuleCheckResult {
  const check = metadata.abilityCheck as { ability: string; skill?: string; roll: number; modifier: number; dc?: number };
  const total = check.roll + check.modifier;
  
  // Check if modifier is within reasonable bounds
  const modifierValid = check.modifier >= -5 && check.modifier <= 20;
  
  return {
    isValid: modifierValid,
    ruleCategory: 'Ability Check',
    details: `${check.skill || check.ability} check: ${check.roll} + ${check.modifier} = ${total}`,
    suggestedCorrection: !modifierValid
      ? `Modifier ${check.modifier} seems outside normal bounds (-5 to +20)`
      : undefined,
  };
}

function checkDC(metadata: Record<string, unknown>): RuleCheckResult {
  const dc = metadata.dc as number;
  
  // Standard DCs range from 5 (very easy) to 30 (nearly impossible)
  const dcValid = dc >= 5 && dc <= 30;
  
  return {
    isValid: dcValid,
    ruleCategory: 'Difficulty Class',
    details: `DC ${dc}`,
    suggestedCorrection: !dcValid
      ? `DC ${dc} is outside standard range (5-30). Standard DCs: 5 Very Easy, 10 Easy, 15 Medium, 20 Hard, 25 Very Hard, 30 Nearly Impossible`
      : undefined,
  };
}

export default ruleAccuracyEvaluator;
