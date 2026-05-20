/**
 * Generate PackActor files for organizations.
 *
 * Organizations should be first-class actors — they post, engage, and trade
 * just like NPC characters. This script reads each PackOrganization .ts file
 * and generates a corresponding PackActor .ts file with the org's voice/style.
 *
 * Usage: bun run scripts/generate-org-actors.ts
 */

import { mkdirSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// We need to read the org TS files. Since they export default objects,
// we'll dynamically import them.

const PERSONALITY_TEMPERATURES: Record<string, number> = {
  company: 0.7,
  media: 0.8,
  government: 0.6,
  vc: 0.75,
  organization: 0.7,
  financial: 0.65,
};

const TIER_BY_ORG_TYPE: Record<string, string> = {
  company: 'B_TIER',
  media: 'C_TIER',
  government: 'B_TIER',
  vc: 'B_TIER',
  organization: 'C_TIER',
  financial: 'B_TIER',
};

// Major orgs get higher tiers
const MAJOR_ORG_IDS = new Set([
  'openagi',
  'aitropic',
  'metai',
  'aiphabet',
  'maicrosoft',
  'aipple',
  'aimazon',
  'teslai',
  'aix',
  'nvidai',
  'coinbaise',
  'palaintir',
]);

const SECONDARY_ORG_IDS = new Set([
  'ethereum-foundaition',
  'straitegy',
  'ainduril',
  'spaicex',
  'the-new-york-taimes',
  'wall-street-journai',
  'faix-news',
  'msainbc',
  'bloombairg',
]);

interface OrgData {
  id: string;
  name: string;
  ticker?: string;
  description: string;
  profileDescription?: string;
  type: string;
  canBeInvolved: boolean;
  postStyle?: string;
  postExample?: string[];
  pfpDescription?: string;
  bannerDescription?: string;
  originalName?: string;
  originalHandle?: string;
  username?: string;
  initialPrice?: number;
}

function orgTypeToPersonality(type: string): string {
  switch (type) {
    case 'company':
      return 'corporate entity';
    case 'media':
      return 'media organization';
    case 'government':
      return 'government institution';
    case 'vc':
      return 'venture capital firm';
    case 'financial':
      return 'financial institution';
    default:
      return 'organization';
  }
}

function orgTypeToDomains(type: string): string[] {
  switch (type) {
    case 'company':
      return ['tech', 'business'];
    case 'media':
      return ['media', 'journalism'];
    case 'government':
      return ['politics', 'policy'];
    case 'vc':
      return ['finance', 'venture_capital'];
    case 'financial':
      return ['finance', 'markets'];
    default:
      return ['business'];
  }
}

function buildOrgSystemPrompt(org: OrgData): string {
  const parts: string[] = [];
  parts.push(
    `You are the official voice of ${org.name}${org.ticker ? ` (${org.ticker})` : ''}, a ${org.type} in the Babylon prediction market simulation.`
  );
  if (org.description) parts.push(org.description);
  if (org.postStyle) parts.push(`Your posting style: ${org.postStyle}`);
  parts.push(
    'You post as a corporate/institutional account — professional but with character. You can comment on markets, share institutional perspectives, react to news about your industry, and engage with other actors.'
  );
  parts.push(
    'You participate in prediction markets, social interactions, and autonomous trading.'
  );
  return parts.join('\n\n');
}

function buildOrgBio(org: OrgData): string[] {
  const bio: string[] = [];
  if (org.description) bio.push(org.description);
  if (org.profileDescription)
    bio.push(`Visual identity: ${org.profileDescription}`);
  return bio.length > 0
    ? bio
    : [`${org.name} — a ${org.type} in the Babylon universe.`];
}

function getTier(org: OrgData): string {
  if (MAJOR_ORG_IDS.has(org.id)) return 'A_TIER';
  if (SECONDARY_ORG_IDS.has(org.id)) return 'B_TIER';
  return TIER_BY_ORG_TYPE[org.type] ?? 'C_TIER';
}

async function generateOrgActors(packDir: string) {
  const orgsDir = join(packDir, 'src/organizations');
  const actorsDir = join(packDir, 'src/actors');
  mkdirSync(actorsDir, { recursive: true });

  const orgFiles = readdirSync(orgsDir).filter(
    (f) => f.endsWith('.ts') && f !== 'index.ts'
  );
  let generated = 0;

  for (const file of orgFiles) {
    const orgModule = await import(join(process.cwd(), orgsDir, file));
    const org: OrgData = orgModule.default;

    // Use org- prefix for the actor ID to avoid collisions with person actors
    const actorId = `org-${org.id}`;
    const actorFile = `org-${file}`;

    // Check if actor already exists (don't overwrite person actors)
    const existingActorFile = join(actorsDir, actorFile);

    const tier = getTier(org);
    const temperature = PERSONALITY_TEMPERATURES[org.type] ?? 0.7;
    const personality = orgTypeToPersonality(org.type);
    const domains = orgTypeToDomains(org.type);

    const packActor = {
      id: actorId,
      name: org.name,
      username: org.username ?? org.id,
      system: buildOrgSystemPrompt(org),
      bio: buildOrgBio(org),
      lore: org.description ? [org.description] : [],
      topics: domains,
      adjectives: [
        'institutional',
        'authoritative',
        personality.split(' ')[0] ?? 'professional',
      ],
      style: {
        all: [
          `Post as the official ${org.name} account`,
          'Maintain institutional tone with character',
          'Be opinionated about your industry',
        ],
        chat: [
          'Respond as an institutional representative',
          'Be direct and authoritative',
        ],
        post: org.postStyle
          ? [org.postStyle]
          : ['Professional institutional voice with personality'],
      },
      messageExamples: [] as Array<
        Array<{ user: string; content: { text: string } }>
      >,
      postExamples: org.postExample ?? [],
      settings: {
        temperature,
        maxTokens: 1100,
      },
      tier,
      domain: domains,
      affiliations: [] as string[], // Orgs don't affiliate with other orgs as actors
      personality,
      voice: org.postStyle ?? `Institutional voice of ${org.name}`,
      postStyle: org.postStyle ?? 'Professional institutional posting',
      description: org.description,
      profileDescription: org.profileDescription,
      pfpDescription: org.pfpDescription ?? `Logo of ${org.name}`,
      profileBanner: org.bannerDescription,
      babylon: {
        alignment: 'neutral' as const,
        team: 'gray' as const,
        scamProfile: 'wary',
        competence: 'high',
        tradingStyle: 'institutional',
        socialStyle: personality,
        autonomy: {
          trading: true,
          posting: true,
          commenting: true,
          dms: false, // Orgs don't DM
          groups: false, // Orgs don't join group chats
        },
        datasetTags: [
          `tier:${tier}`,
          'type:organization',
          `org-type:${org.type}`,
          ...domains.map((d) => `domain:${d}`),
        ],
      },
      // Identity mapping
      realName: org.originalName ?? org.name,
      originalFirstName: org.originalName ?? org.name,
      originalLastName: '',
      originalHandle: org.originalHandle ?? org.username ?? org.id,
      firstName: org.name,
      lastName: '',
    };

    // Write as TypeScript file matching the existing pattern
    const content = `import type { PackActor } from '@babylon/shared';

const actor = ${JSON.stringify(packActor, null, 2)} as const satisfies PackActor;

export default actor;
`;

    writeFileSync(existingActorFile, content);
    generated++;
  }

  console.log(`Generated ${generated} org-actor files in ${actorsDir}`);
  return generated;
}

async function main() {
  // Generate for pack-default
  console.log('=== pack-default ===');
  const defaultCount = await generateOrgActors('packages/pack-default');

  // Generate for pack-corporate-30-under-30
  console.log('\n=== pack-corporate-30-under-30 ===');
  const corpCount = await generateOrgActors(
    'packages/pack-corporate-30-under-30'
  );

  console.log(`\nTotal: ${defaultCount + corpCount} org-actor files generated`);
  console.log(
    '\nNext: run scripts/rebuild-pack-indexes.ts to update actors-index.ts and manifest.ts'
  );
}

main().catch(console.error);
