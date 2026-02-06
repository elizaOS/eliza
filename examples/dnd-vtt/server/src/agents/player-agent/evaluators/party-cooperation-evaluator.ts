/**
 * Party Cooperation Evaluator
 * Assesses how well the player works with the party
 */

import type { Evaluator, IAgentRuntime, Memory, State } from '@elizaos/core';

export interface CooperationMetrics {
  contributesToDiscussion: number;  // 0-10: Participates in group decisions
  supportsAllies: number;           // 0-10: Helps other party members
  sharesInformation: number;        // 0-10: Communicates findings
  respectsOthers: number;           // 0-10: Doesn't overshadow others
  overallCooperation: number;
}

export const partyCooperationEvaluator: Evaluator = {
  name: 'partyCooperation',
  description: 'Evaluates how well the player cooperates with the party',
  
  alwaysRun: true,
  
  similes: [
    'teamwork',
    'party dynamics',
    'cooperation',
    'group play',
  ],
  
  examples: [
    {
      prompt: 'Player ignores party discussion and acts alone',
      messages: [
        {
          name: 'player',
          content: {
            text: 'While they\'re talking, I sneak off to explore the dungeon alone.',
          },
        },
      ],
      outcome: 'Low cooperation - should work with party.',
    },
  ],
  
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const role = await runtime.getSetting('role');
    return role === 'player';
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ) => {
    const text = typeof message.content === 'string'
      ? message.content
      : message.content?.text;
    
    if (!text) return undefined;
    
    const lowerText = text.toLowerCase();
    
    const metrics: CooperationMetrics = {
      contributesToDiscussion: evaluateDiscussionContribution(lowerText),
      supportsAllies: evaluateAllySupport(lowerText),
      sharesInformation: evaluateInfoSharing(lowerText),
      respectsOthers: evaluateRespect(lowerText),
      overallCooperation: 0,
    };
    
    // Calculate overall
    metrics.overallCooperation = Math.round(
      (metrics.contributesToDiscussion +
       metrics.supportsAllies +
       metrics.sharesInformation +
       metrics.respectsOthers) / 4 * 10
    ) / 10;
    
    // Track cooperation over time
    const historyRaw = await runtime.getSetting('cooperationHistory');
    const history = (historyRaw ? JSON.parse(historyRaw as string) : []) as CooperationMetrics[];
    history.push(metrics);
    if (history.length > 20) history.shift();
    await runtime.setSetting('cooperationHistory', JSON.stringify(history));
    
    // Calculate running average
    const avgCooperation = history.reduce((sum, m) => sum + m.overallCooperation, 0) / history.length;
    
    // Warn if consistently low cooperation
    if (history.length >= 5 && avgCooperation < 4) {
      runtime.emitEvent?.('cooperation_warning' as any, {
        avgScore: avgCooperation,
        suggestion: 'Consider interacting more with party members and supporting group decisions',
        timestamp: new Date(),
      });
    }
    return undefined;
  },
};

function evaluateDiscussionContribution(text: string): number {
  let score = 6;
  
  // Positive contribution indicators
  const contributionPatterns = [
    /\b(I think|I suggest|what if|we could|perhaps)\b/i,
    /\b(agree|disagree|consider|opinion)\b/i,
    /\b(let's|we should|how about)\b/i,
    /\b(idea|plan|strategy)\b/i,
  ];
  
  for (const pattern of contributionPatterns) {
    if (pattern.test(text)) score += 1;
  }
  
  // Negative indicators
  if (/\b(don't care|whatever|doesn't matter)\b/i.test(text)) {
    score -= 2;
  }
  
  // Ignoring others
  if (/\b(ignore|don't listen|while they)\b/i.test(text)) {
    score -= 2;
  }
  
  return Math.max(0, Math.min(10, score));
}

function evaluateAllySupport(text: string): number {
  let score = 6;
  
  // Support indicators
  const supportPatterns = [
    /\b(help|assist|support|protect|defend)\b/i,
    /\b(heal|cover|flank|back up)\b/i,
    /\b(ally|friend|companion|party member)\b/i,
    /\b(together|team|we)\b/i,
  ];
  
  for (const pattern of supportPatterns) {
    if (pattern.test(text)) score += 1;
  }
  
  // Solo/selfish indicators
  if (/\b(myself|alone|my own|just me)\b/i.test(text)) {
    score -= 1;
  }
  
  if (/\b(leave them|abandon|not my problem)\b/i.test(text)) {
    score -= 3;
  }
  
  return Math.max(0, Math.min(10, score));
}

function evaluateInfoSharing(text: string): number {
  let score = 6;
  
  // Sharing indicators
  const sharingPatterns = [
    /\b(tell|inform|share|let.*know|mention)\b/i,
    /\b(I found|I noticed|I discovered|look at this)\b/i,
    /\b(everyone|group|party|all of you)\b/i,
    /\b(warning|heads up|watch out|be careful)\b/i,
  ];
  
  for (const pattern of sharingPatterns) {
    if (pattern.test(text)) score += 1;
  }
  
  // Withholding indicators
  if (/\b(keep.*secret|don't tell|hide.*from)\b/i.test(text)) {
    score -= 2; // Could be character appropriate, minor penalty
  }
  
  return Math.max(0, Math.min(10, score));
}

function evaluateRespect(text: string): number {
  let score = 7;
  
  // Respectful indicators
  const respectPatterns = [
    /\b(thank|appreciate|good idea|well done)\b/i,
    /\b(you're right|fair point|I understand)\b/i,
    /\b(after you|your turn|you should)\b/i,
  ];
  
  for (const pattern of respectPatterns) {
    if (pattern.test(text)) score += 1;
  }
  
  // Disrespectful indicators
  if (/\b(stupid|idiot|useless|incompetent)\b/i.test(text)) {
    score -= 2;
  }
  
  // Spotlight hogging
  if (/\b(I'll do it all|let me handle everything|stand back)\b/i.test(text)) {
    score -= 1;
  }
  
  // Interrupting
  if (/\b(interrupt|cut.*off|before they can)\b/i.test(text)) {
    score -= 1;
  }
  
  return Math.max(0, Math.min(10, score));
}

export default partyCooperationEvaluator;
