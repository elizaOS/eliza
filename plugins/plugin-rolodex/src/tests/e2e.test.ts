import { TestSuite, stringToUuid } from '@elizaos/core';
import { RolodexService } from '../services/RolodexService';
import { FollowUpService } from '../services/FollowUpService';

export const rolodexE2ETests: TestSuite = {
  name: 'Rolodex E2E Tests',
  tests: [
    {
      name: 'should add and retrieve a contact',
      fn: async (runtime) => {
        try {
          const rolodexService = runtime.getService('rolodex') as RolodexService;

          if (!rolodexService) {
            throw new Error('RolodexService not found');
          }

          // Create a test entity
          const entityId = stringToUuid('test-contact-' + Date.now());

          // Add as contact
          const contact = await rolodexService.addContact(entityId, ['friend', 'colleague'], {
            timezone: 'UTC',
            language: 'en',
          });

          // Verify it was added
          if (!contact) {
            throw new Error('Failed to add contact');
          }

          if (contact.entityId !== entityId) {
            throw new Error(`Contact ID mismatch: expected ${entityId}, got ${contact.entityId}`);
          }

          if (!contact.categories.includes('friend') || !contact.categories.includes('colleague')) {
            throw new Error('Contact categories not set correctly');
          }

          // Retrieve the contact
          const retrieved = await rolodexService.getContact(entityId);

          if (!retrieved) {
            throw new Error('Failed to retrieve contact');
          }

          if (retrieved.entityId !== entityId) {
            throw new Error('Retrieved contact has wrong ID');
          }
        } catch (error) {
          console.error('Test failed:', error);
          throw error;
        }
      },
    },
    {
      name: 'should search contacts by category',
      fn: async (runtime) => {
        try {
          const rolodexService = runtime.getService('rolodex') as RolodexService;

          if (!rolodexService) {
            throw new Error('RolodexService not found');
          }

          // Add multiple contacts
          const entityId1 = stringToUuid('friend-contact-' + Date.now());
          const entityId2 = stringToUuid('colleague-contact-' + Date.now());

          await rolodexService.addContact(entityId1, ['friend']);
          await rolodexService.addContact(entityId2, ['colleague']);

          // Search for friends
          const friends = await rolodexService.searchContacts({ categories: ['friend'] });

          if (friends.length === 0) {
            throw new Error('No friends found');
          }

          const foundFriend = friends.find((c) => c.entityId === entityId1);
          if (!foundFriend) {
            throw new Error('Friend contact not found in search results');
          }

          // Search for colleagues
          const colleagues = await rolodexService.searchContacts({ categories: ['colleague'] });

          if (colleagues.length === 0) {
            throw new Error('No colleagues found');
          }

          const foundColleague = colleagues.find((c) => c.entityId === entityId2);
          if (!foundColleague) {
            throw new Error('Colleague contact not found in search results');
          }
        } catch (error) {
          console.error('Test failed:', error);
          throw error;
        }
      },
    },
    {
      name: 'should schedule and retrieve follow-ups',
      fn: async (runtime) => {
        try {
          const rolodexService = runtime.getService('rolodex') as RolodexService;
          const followUpService = runtime.getService('follow_up') as FollowUpService;

          if (!rolodexService || !followUpService) {
            throw new Error('Required services not found');
          }

          // Create a contact
          const entityId = stringToUuid('followup-contact-' + Date.now());
          await rolodexService.addContact(entityId, ['friend']);

          // Schedule a follow-up
          const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
          const task = await followUpService.scheduleFollowUp(
            entityId,
            tomorrow,
            'Check in',
            'high'
          );

          if (!task) {
            throw new Error('Failed to schedule follow-up');
          }

          // Get upcoming follow-ups
          const upcoming = await followUpService.getUpcomingFollowUps(7);

          if (upcoming.length === 0) {
            throw new Error('No upcoming follow-ups found');
          }

          const found = upcoming.find((f) => f.task.id === task.id);
          if (!found) {
            throw new Error('Scheduled follow-up not found in upcoming list');
          }
        } catch (error) {
          console.error('Test failed:', error);
          throw error;
        }
      },
    },
    {
      name: 'should update contact information',
      fn: async (runtime) => {
        try {
          const rolodexService = runtime.getService('rolodex') as RolodexService;

          if (!rolodexService) {
            throw new Error('RolodexService not found');
          }

          // Create a contact
          const entityId = stringToUuid('update-contact-' + Date.now());
          await rolodexService.addContact(entityId, ['acquaintance']);

          // Update the contact
          const updated = await rolodexService.updateContact(entityId, {
            categories: ['friend', 'vip'],
            tags: ['tech', 'startup'],
            preferences: { timezone: 'PST', language: 'en' },
          });

          if (!updated) {
            throw new Error('Failed to update contact');
          }

          if (!updated.categories.includes('vip')) {
            throw new Error('Contact categories not updated');
          }

          if (updated.tags.length !== 2) {
            throw new Error('Contact tags not updated');
          }

          // Verify persistence
          const retrieved = await rolodexService.getContact(entityId);

          if (!retrieved) {
            throw new Error('Updated contact not found');
          }

          if (!retrieved.categories.includes('vip')) {
            throw new Error('Updated categories not persisted');
          }
        } catch (error) {
          console.error('Test failed:', error);
          throw error;
        }
      },
    },
  ],
};
