import type { OrgCorrelation } from '@feed/shared';

/**
 * Inter-organization correlations for the default Feed pack.
 * Defines supply chains, competitive relationships, partnerships, and investments.
 *
 * Migrated from packages/engine MarketCorrelation format.
 */
export const correlations: OrgCorrelation[] = [
  // NVIDIA supply chain
  {
    orgId: 'nvidai',
    relatedOrgId: 'openagi',
    type: 'supplier',
    strength: 0.25,
  },
  {
    orgId: 'nvidai',
    relatedOrgId: 'aitropic',
    type: 'supplier',
    strength: 0.25,
  },
  { orgId: 'nvidai', relatedOrgId: 'metai', type: 'supplier', strength: 0.2 },
  {
    orgId: 'nvidai',
    relatedOrgId: 'aiphabet',
    type: 'supplier',
    strength: 0.15,
  },
  { orgId: 'nvidai', relatedOrgId: 'teslai', type: 'supplier', strength: 0.2 },

  // AI lab competition
  {
    orgId: 'openagi',
    relatedOrgId: 'aitropic',
    type: 'competitor',
    strength: -0.15,
  },
  {
    orgId: 'openagi',
    relatedOrgId: 'deepmaind',
    type: 'competitor',
    strength: -0.12,
  },
  {
    orgId: 'aitropic',
    relatedOrgId: 'openagi',
    type: 'competitor',
    strength: -0.15,
  },

  // Microsoft ↔ OpenAI
  {
    orgId: 'openagi',
    relatedOrgId: 'maicrosoft',
    type: 'partner',
    strength: 0.3,
  },
  {
    orgId: 'maicrosoft',
    relatedOrgId: 'openagi',
    type: 'investor',
    strength: 0.25,
  },

  // Big tech competition
  {
    orgId: 'aiphabet',
    relatedOrgId: 'metai',
    type: 'competitor',
    strength: -0.1,
  },
  {
    orgId: 'metai',
    relatedOrgId: 'aiphabet',
    type: 'competitor',
    strength: -0.1,
  },
  {
    orgId: 'aipple',
    relatedOrgId: 'aiphabet',
    type: 'competitor',
    strength: -0.08,
  },
  {
    orgId: 'aipple',
    relatedOrgId: 'maicrosoft',
    type: 'competitor',
    strength: -0.05,
  },

  // Musk empire (shared executive → partner)
  { orgId: 'teslai', relatedOrgId: 'aix', type: 'partner', strength: 0.2 },
  { orgId: 'teslai', relatedOrgId: 'spaicex', type: 'partner', strength: 0.15 },
  {
    orgId: 'teslai',
    relatedOrgId: 'neurailink',
    type: 'partner',
    strength: 0.15,
  },
  { orgId: 'aix', relatedOrgId: 'teslai', type: 'partner', strength: 0.2 },
  { orgId: 'spaicex', relatedOrgId: 'teslai', type: 'partner', strength: 0.15 },
  {
    orgId: 'teslai',
    relatedOrgId: 'aipple',
    type: 'competitor',
    strength: -0.08,
  },

  // Cloud / e-commerce competition
  {
    orgId: 'aimazon',
    relatedOrgId: 'maicrosoft',
    type: 'competitor',
    strength: -0.1,
  },
  {
    orgId: 'aimazon',
    relatedOrgId: 'aiphabet',
    type: 'competitor',
    strength: -0.1,
  },
  {
    orgId: 'maicrosoft',
    relatedOrgId: 'aimazon',
    type: 'competitor',
    strength: -0.1,
  },

  // Crypto ecosystem
  {
    orgId: 'coinbaise',
    relatedOrgId: 'ethereum-foundaition',
    type: 'partner',
    strength: 0.15,
  },
  {
    orgId: 'straitegy',
    relatedOrgId: 'coinbaise',
    type: 'partner',
    strength: 0.12,
  },

  // VC investments
  { orgId: 'ai16z', relatedOrgId: 'openagi', type: 'investor', strength: 0.1 },
  {
    orgId: 'sequoai-capital',
    relatedOrgId: 'openagi',
    type: 'investor',
    strength: 0.1,
  },

  // Defense tech competition
  {
    orgId: 'palaintir',
    relatedOrgId: 'ainduril',
    type: 'competitor',
    strength: -0.12,
  },
  {
    orgId: 'ainduril',
    relatedOrgId: 'palaintir',
    type: 'competitor',
    strength: -0.12,
  },

  // Media competition
  {
    orgId: 'faix-news',
    relatedOrgId: 'ainbc',
    type: 'competitor',
    strength: -0.1,
  },
  {
    orgId: 'the-new-york-taimes',
    relatedOrgId: 'wall-street-journai',
    type: 'competitor',
    strength: -0.08,
  },
];
