import type { OrgCorrelation } from '@babylon/shared';

/**
 * Inter-organization correlations for the 30 Under 30 pack.
 * Defines competitive relationships, investment flows, partnerships,
 * and supply chains between the fictional companies.
 */
export const correlations: OrgCorrelation[] = [
  // Finance cluster: Sterling, Aphelion, Polar, DragonPay, Forge compete/partner
  {
    orgId: 'sterling-ventures',
    relatedOrgId: 'aphelion-capital',
    type: 'competitor',
    strength: -0.15,
  },
  {
    orgId: 'sterling-ventures',
    relatedOrgId: 'polar-capital',
    type: 'competitor',
    strength: -0.2,
  },
  {
    orgId: 'aphelion-capital',
    relatedOrgId: 'polar-capital',
    type: 'competitor',
    strength: -0.1,
  },
  {
    orgId: 'dragonpay',
    relatedOrgId: 'sterling-ventures',
    type: 'partner',
    strength: 0.2,
  },
  {
    orgId: 'forge-capital',
    relatedOrgId: 'sterling-ventures',
    type: 'investor',
    strength: 0.15,
  },

  // Forge Capital investments (friends' companies)
  {
    orgId: 'forge-capital',
    relatedOrgId: 'casablock',
    type: 'investor',
    strength: 0.25,
  },
  {
    orgId: 'forge-capital',
    relatedOrgId: 'apex-dynamics',
    type: 'investor',
    strength: 0.2,
  },
  {
    orgId: 'forge-capital',
    relatedOrgId: 'nimbus-cloud',
    type: 'investor',
    strength: 0.15,
  },

  // AI/Tech cluster: NeuraSpark, Lumen AI, Verdant AI, Sakura Robotics compete
  {
    orgId: 'neuraspark',
    relatedOrgId: 'lumen-ai',
    type: 'competitor',
    strength: -0.15,
  },
  {
    orgId: 'neuraspark',
    relatedOrgId: 'sakura-robotics',
    type: 'competitor',
    strength: -0.1,
  },
  {
    orgId: 'lumen-ai',
    relatedOrgId: 'verdant-ai',
    type: 'competitor',
    strength: -0.08,
  },
  {
    orgId: 'sakura-robotics',
    relatedOrgId: 'neuraspark',
    type: 'competitor',
    strength: -0.12,
  },

  // Sustainability/energy cluster
  {
    orgId: 'verdana-health',
    relatedOrgId: 'verdant-ai',
    type: 'partner',
    strength: 0.1,
  },
  {
    orgId: 'aether-energy',
    relatedOrgId: 'verdant-ai',
    type: 'partner',
    strength: 0.15,
  },
  {
    orgId: 'kibali-mining-tech',
    relatedOrgId: 'aether-energy',
    type: 'supplier',
    strength: 0.2,
  },
  {
    orgId: 'kibali-mining-tech',
    relatedOrgId: 'verdant-ai',
    type: 'competitor',
    strength: -0.2,
  },

  // Crypto cluster: OmniChain, CasaBlock, Maison Protocol, DragonPay co-move
  {
    orgId: 'omnichain',
    relatedOrgId: 'casablock',
    type: 'partner',
    strength: 0.15,
  },
  {
    orgId: 'omnichain',
    relatedOrgId: 'maison-protocol',
    type: 'partner',
    strength: 0.1,
  },
  {
    orgId: 'casablock',
    relatedOrgId: 'maison-protocol',
    type: 'partner',
    strength: 0.12,
  },
  {
    orgId: 'dragonpay',
    relatedOrgId: 'omnichain',
    type: 'partner',
    strength: 0.1,
  },

  // Cybersecurity rivalry
  {
    orgId: 'meridian-systems',
    relatedOrgId: 'ironclad-security',
    type: 'competitor',
    strength: -0.25,
  },
  {
    orgId: 'ironclad-security',
    relatedOrgId: 'meridian-systems',
    type: 'competitor',
    strength: -0.25,
  },

  // Tech infrastructure
  {
    orgId: 'nimbus-cloud',
    relatedOrgId: 'velocity-labs',
    type: 'supplier',
    strength: 0.15,
  },
  {
    orgId: 'nimbus-cloud',
    relatedOrgId: 'neuraspark',
    type: 'supplier',
    strength: 0.1,
  },
  {
    orgId: 'nimbus-cloud',
    relatedOrgId: 'lumen-ai',
    type: 'supplier',
    strength: 0.1,
  },

  // Media/attention cluster
  {
    orgId: 'olympus-media',
    relatedOrgId: 'stellar-commerce',
    type: 'partner',
    strength: 0.2,
  },
  {
    orgId: 'olympus-media',
    relatedOrgId: 'prism-analytics',
    type: 'partner',
    strength: 0.25,
  },
  {
    orgId: 'prism-analytics',
    relatedOrgId: 'stellar-commerce',
    type: 'supplier',
    strength: 0.2,
  },

  // Defense/logistics
  {
    orgId: 'titan-defense-tech',
    relatedOrgId: 'atlas-logistics',
    type: 'partner',
    strength: 0.1,
  },
  {
    orgId: 'sakura-robotics',
    relatedOrgId: 'titan-defense-tech',
    type: 'supplier',
    strength: 0.15,
  },
  {
    orgId: 'sakura-robotics',
    relatedOrgId: 'atlas-logistics',
    type: 'supplier',
    strength: 0.12,
  },

  // Health/biotech cluster
  {
    orgId: 'catalyst-bio',
    relatedOrgId: 'bloom-therapeutics',
    type: 'competitor',
    strength: -0.1,
  },
  {
    orgId: 'verdana-health',
    relatedOrgId: 'bloom-therapeutics',
    type: 'competitor',
    strength: -0.08,
  },
  {
    orgId: 'catalyst-bio',
    relatedOrgId: 'verdana-health',
    type: 'competitor',
    strength: -0.05,
  },

  // HarmonyOS needs chips from robotics supply chain
  {
    orgId: 'harmonyos',
    relatedOrgId: 'sakura-robotics',
    type: 'partner',
    strength: 0.1,
  },

  // Zenith Labs has vague connections to everyone (they've pivoted toward each industry)
  {
    orgId: 'zenith-labs',
    relatedOrgId: 'neuraspark',
    type: 'competitor',
    strength: -0.05,
  },
  {
    orgId: 'zenith-labs',
    relatedOrgId: 'aether-energy',
    type: 'competitor',
    strength: -0.05,
  },

  // EduVerse uses tech from various partners
  {
    orgId: 'eduverse',
    relatedOrgId: 'lumen-ai',
    type: 'partner',
    strength: 0.08,
  },
  {
    orgId: 'eduverse',
    relatedOrgId: 'nimbus-cloud',
    type: 'supplier',
    strength: 0.05,
  },
];
