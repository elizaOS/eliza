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
      ...starterCampaign,
      startingLocationId: undefined, // Will be set after locations are created
    });
    console.log(`   Created campaign: ${campaign.name} (${campaign.id})`);

    // Create locations
    console.log('\n🗺️  Creating locations...');
    const locationMap = new Map<string, string>();
    
    for (const locationData of starterLocations) {
      const location = await locationRepository.create({
        ...locationData,
        campaignId: campaign.id,
        parentLocationId: undefined,
      });
      
      // Map location name to ID for reference
      const key = locationData.name.toLowerCase().replace(/\s+/g, '-');
      locationMap.set(key, location.id);
      
      console.log(`   Created location: ${location.name} (${location.id})`);
    }

    // Update campaign with starting location
    const startingLocationId = locationMap.get('millbrook-village');
    if (startingLocationId) {
      await campaignRepository.update(campaign.id, {
        currentLocationId: startingLocationId,
      });
      console.log(`   Set starting location to Millbrook Village`);
    }

    // Create NPCs
    console.log('\n👤 Creating NPCs...');
    for (const npcData of starterNPCs) {
      // Map location names to IDs
      let currentLocationId = npcData.currentLocationId;
      if (currentLocationId === 'millbrook-village') {
        currentLocationId = locationMap.get('millbrook-village');
      } else if (currentLocationId === 'goblin-den') {
        currentLocationId = locationMap.get('the-goblin-den');
      }

      const npc = await locationRepository.createNPC({
        ...npcData,
        campaignId: campaign.id,
        currentLocationId: currentLocationId || undefined,
      });
      console.log(`   Created NPC: ${npc.name} (${npc.id})`);
    }

    // Create quests
    console.log('\n⚔️  Creating quests...');
    for (const questData of starterQuests) {
      const quest = await worldRepository.createQuest({
        ...questData,
        campaignId: campaign.id,
        locationId: locationMap.get('the-goblin-den'),
      });
      console.log(`   Created quest: ${quest.name} (${quest.id})`);
    }

    // Create party members
    console.log('\n🎭 Creating party members...');
    for (const characterData of starterParty) {
      const character = await characterRepository.create({
        ...characterData,
        campaignId: campaign.id,
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
