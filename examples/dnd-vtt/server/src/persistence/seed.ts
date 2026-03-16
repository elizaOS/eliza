/**
 * Database Seeder
 * Seeds the database with starter adventure content
 */

import { v4 as uuid } from 'uuid';
import { initializeDatabase, closeDatabase, getDatabase } from './database';
import { campaignRepository, characterRepository, locationRepository, worldRepository } from './repositories';
import {
  starterCampaign,
  starterLocations,
  starterNPCs,
  starterQuests,
  starterParty,
} from '../content';

async function seed() {
  console.log('🌱 Starting database seed...\n');

  try {
    await initializeDatabase();
    console.log('✅ Database connected\n');

    // Create campaign
    console.log('📜 Creating campaign...');
    const campaign = await campaignRepository.create({
      name: starterCampaign.name,
      description: starterCampaign.description,
      dmAgentId: 'seed-dm-agent',
      setting: starterCampaign.setting,
      tone: starterCampaign.tone,
      themes: starterCampaign.themes,
      sessionCount: starterCampaign.sessionCount,
      totalPlayTime: starterCampaign.totalPlayTime,
      status: starterCampaign.status,
    });
    const campaignId = campaign.id!;
    console.log(`   Created campaign: ${campaign.name} (${campaignId})`);

    // Create locations
    console.log('\n🗺️  Creating locations...');
    const locationMap = new Map<string, string>();
    
    for (const locationData of starterLocations) {
      const location = await locationRepository.create({
        name: locationData.name,
        type: locationData.type,
        description: locationData.description,
        campaignId: campaignId,
        parentLocationId: undefined,
        tags: locationData.tags,
        npcs: locationData.npcs,
        pointsOfInterest: locationData.pointsOfInterest,
        availableServices: locationData.availableServices,
        dangerLevel: locationData.dangerLevel,
      });
      
      // Map location name to ID for reference
      const key = locationData.name.toLowerCase().replace(/\s+/g, '-');
      locationMap.set(key, location.id!);
      
      console.log(`   Created location: ${location.name} (${location.id})`);
    }

    // Update campaign with starting location
    const startingLocationId = locationMap.get('millbrook-village');
    if (startingLocationId) {
      await campaignRepository.update(campaignId, {
        currentLocationId: startingLocationId,
      });
      console.log(`   Set starting location to Millbrook Village`);
    }

    // Create NPCs
    console.log('\n👤 Creating NPCs...');
    for (const npcData of starterNPCs) {
      // Map location names to IDs
      let resolvedLocationId = npcData.currentLocationId;
      if (resolvedLocationId === 'millbrook-village') {
        resolvedLocationId = locationMap.get('millbrook-village');
      } else if (resolvedLocationId === 'goblin-den') {
        resolvedLocationId = locationMap.get('the-goblin-den');
      }

      const npc = await locationRepository.createNPC({
        campaignId: campaignId,
        name: npcData.name,
        type: npcData.type,
        race: npcData.race,
        occupation: npcData.occupation,
        personality: npcData.personality,
        motivation: npcData.motivation,
        secrets: npcData.secrets,
        locationId: resolvedLocationId || undefined,
        isHostile: npcData.isHostile,
      });
      console.log(`   Created NPC: ${npc.name} (${npc.id})`);
    }

    // Create quests
    console.log('\n⚔️  Creating quests...');
    for (const questData of starterQuests) {
      const quest = await worldRepository.createQuest({
        campaignId: campaignId,
        name: questData.name,
        description: questData.description,
        type: questData.type,
        giver: questData.giver,
        locationId: locationMap.get('the-goblin-den'),
        objectives: questData.objectives.map(o => ({ description: o.description })),
        rewards: questData.rewards,
        importance: questData.importance,
      });
      console.log(`   Created quest: ${quest.name} (${quest.id})`);
    }

    // Create party members
    console.log('\n🎭 Creating party members...');
    for (const characterData of starterParty) {
      const character = await characterRepository.create({
        campaignId: campaignId,
        sheet: characterData as import('../types').CharacterSheet,
      });
      console.log(`   Created character: ${character.name} (${character.id})`);
    }

    console.log('\n═══════════════════════════════════════════════');
    console.log('  ✅ Database seeded successfully!');
    console.log('═══════════════════════════════════════════════');
    console.log(`\n  Campaign ID: ${campaign.id}`);
    console.log(`  Locations: ${starterLocations.length}`);
    console.log(`  NPCs: ${starterNPCs.length}`);
    console.log(`  Quests: ${starterQuests.length}`);
    console.log(`  Party Members: ${starterParty.length}`);
    console.log('\n');

  } catch (error) {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  } finally {
    await closeDatabase();
  }
}

// Run seeder
seed();
