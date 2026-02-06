import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { stringToUuid } from '@elizaos/core';
import {
  createMockRuntime,
  createMockMemory,
  createMockState,
  createMockEntity,
} from './test-utils';

// Mock the findEntityByName function before imports to avoid hoisting issues
mock.module('@elizaos/core', () => {
  const actual = require('@elizaos/core');
  return {
    ...actual,
    findEntityByName: mock(() => null),
  };
});

// Import actions after mocking
import {
  addContactAction,
  updateContactAction,
  removeContactAction,
  scheduleFollowUpAction,
  searchContactsAction,
} from '../actions';
import { RolodexService, FollowUpService } from '../services';
import { findEntityByName as mockFindEntityByName } from '@elizaos/core';

describe('Rolodex Actions', () => {
  let mockRuntime: any;
  let mockRolodexService: any;
  let mockFollowUpService: any;
  let mockCallback: any;

  beforeEach(() => {
    // Clear all mocks

    // Reset the mock implementation for each test
    (mockFindEntityByName as any).mockImplementation(
      async (runtime: any, message: any, state: any) => {
        const contactName = state?.extractedContactName || 'John Doe';
        return createMockEntity(
          contactName,
          stringToUuid(contactName.toLowerCase().replace(/\s+/g, '-'))
        );
      }
    );

    mockRolodexService = {
      addContact: mock(() => Promise.resolve({
        entityId: stringToUuid('test-entity'),
        categories: ['friend'],
        tags: [],
        preferences: {},
        customFields: {},
        privacyLevel: 'private',
        lastModified: new Date().toISOString(),
      })),
      updateContact: mock(() => Promise.resolve({
        entityId: stringToUuid('test-entity'),
        categories: ['friend', 'vip'],
        tags: ['important'],
        preferences: { timezone: 'PST' },
        customFields: {},
        privacyLevel: 'private',
        lastModified: new Date().toISOString(),
      })),
      removeContact: mock(() => Promise.resolve(true)),
      searchContacts: mock(() => Promise.resolve([])),
      getContact: mock(() => Promise.resolve(null)),
    };

    mockFollowUpService = {
      scheduleFollowUp: mock(() => Promise.resolve({
        id: stringToUuid('task-1'),
        name: 'follow_up',
        metadata: {
          entityId: stringToUuid('test-entity'),
          scheduledAt: new Date().toISOString(),
          reason: 'Test follow-up',
          priority: 'high',
        },
      })),
    };

    mockRuntime = createMockRuntime({
      getService: mock((name: string) => {
        if (name === 'rolodex') return mockRolodexService;
        if (name === 'follow_up') return mockFollowUpService;
        return null;
      }),
      useModel: mock(() => Promise.resolve('<response><contactName>John Doe</contactName></response>')) as any,
    });

    mockCallback = mock(() => { });
  });

  describe('addContactAction', () => {
    it('should validate when intent matches', async () => {
      const message = createMockMemory({
        content: {
          text: 'Add John Doe to my contacts as a friend',
        },
      });

      const isValid = await addContactAction.validate(mockRuntime, message);
      expect(isValid).toBe(true);
    });

    it('should not validate without proper intent', async () => {
      const message = createMockMemory({
        content: {
          text: 'Hello there',
        },
      });

      const isValid = await addContactAction.validate(mockRuntime, message);
      expect(isValid).toBe(false);
    });

    it('should handle adding a contact successfully', async () => {
      const message = createMockMemory({
        content: {
          text: 'Add John Doe to my contacts as a friend',
        },
      });

      const state = createMockState({
        extractedContactName: 'John Doe',
      });

      mockRuntime.useModel.mockResolvedValue(`
        <response>
          <contactName>John Doe</contactName>
          <categories>friend</categories>
          <preferences>timezone:UTC</preferences>
          <timezone>UTC</timezone>
        </response>
      `);

      // Update the mock service to return the expected categories
      mockRolodexService.addContact.mockResolvedValue({
        entityId: stringToUuid('john-doe'),
        categories: ['friend'],
        tags: [],
        preferences: { timezone: 'UTC' },
        customFields: {},
        privacyLevel: 'private',
        lastModified: new Date().toISOString(),
      });

      await addContactAction.handler(mockRuntime, message, state, undefined, mockCallback);

      expect(mockRolodexService.addContact).toHaveBeenCalledWith(
        stringToUuid('john-doe'),
        ['friend'],
        expect.objectContaining({ timezone: 'UTC' })
      );
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("I've added John Doe"),
          action: 'ADD_CONTACT',
        })
      );
    });

    it('should throw an error when the rolodex service is unavailable', async () => {
      const message = createMockMemory({
        content: {
          text: 'Add John Doe to my contacts',
        },
      });

      // Set up the mock runtime to simulate the Rolodex service being unavailable.
      const runtimeWithoutRolodex = createMockRuntime({
        getService: mock((name: string) => {
          if (name === 'rolodex') {
            return null; // Simulate service not found
          }
          return mockFollowUpService;
        }),
        useModel: mockRuntime.useModel, // Reuse the existing model mock
      });

      // Assert that the handler throws the specific error.
      await expect(
        addContactAction.handler(runtimeWithoutRolodex, message, undefined, undefined, mockCallback)
      ).rejects.toThrow('RolodexService not available');

      // In this failure case, the final callback should not be invoked.
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully from findEntityByName', async () => {
      const message = createMockMemory({
        content: {
          text: 'Add John Doe to my contacts',
        },
      });

      // Mock findEntityByName to throw an error
      (mockFindEntityByName as any).mockImplementationOnce(() => {
        throw new Error('Service unavailable');
      });

      await addContactAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("couldn't add the contact"),
        })
      );
    });
  });

  describe('updateContactAction', () => {
    it('should validate update intent', async () => {
      const message = createMockMemory({
        content: {
          text: 'Update John Doe and add the VIP tag',
        },
      });

      const isValid = await updateContactAction.validate(mockRuntime, message);
      expect(isValid).toBe(true);
    });

    it('should update contact successfully', async () => {
      const message = createMockMemory({
        content: {
          text: 'Change Sarah to a VIP contact',
        },
      });

      mockRuntime.useModel.mockResolvedValue(`
        <response>
          <contactName>Sarah</contactName>
          <operation>replace</operation>
          <categories>vip</categories>
        </response>
      `);

      mockRolodexService.searchContacts.mockResolvedValue([
        {
          entityId: stringToUuid('sarah'),
          categories: ['friend'],
          tags: [],
          preferences: {},
          customFields: {},
          privacyLevel: 'private',
          lastModified: new Date().toISOString(),
        },
      ]);

      await updateContactAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

      expect(mockRolodexService.searchContacts).toHaveBeenCalledWith({ searchTerm: 'Sarah' });
      expect(mockRolodexService.updateContact).toHaveBeenCalledWith(
        stringToUuid('sarah'),
        expect.objectContaining({ categories: ['vip'] })
      );
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("updated Sarah's contact information"),
          action: 'UPDATE_CONTACT',
        })
      );
    });

    it('should handle add_to operation', async () => {
      const message = createMockMemory({
        content: {
          text: 'Add tech tag to John',
        },
      });

      mockRuntime.useModel.mockResolvedValue(`
        <response>
          <contactName>John</contactName>
          <operation>add_to</operation>
          <tags>tech</tags>
        </response>
      `);

      mockRolodexService.searchContacts.mockResolvedValue([
        {
          entityId: stringToUuid('john'),
          categories: ['friend'],
          tags: ['developer'],
          preferences: {},
          customFields: {},
          privacyLevel: 'private',
          lastModified: new Date().toISOString(),
        },
      ]);

      await updateContactAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

      expect(mockRolodexService.updateContact).toHaveBeenCalledWith(
        stringToUuid('john'),
        expect.objectContaining({ tags: ['developer', 'tech'] })
      );
    });
  });

  describe('removeContactAction', () => {
    it('should validate remove intent', async () => {
      const message = createMockMemory({
        content: {
          text: 'Remove John from my contacts',
        },
      });

      const isValid = await removeContactAction.validate(mockRuntime, message);
      expect(isValid).toBe(true);
    });

    it('should request confirmation before removing', async () => {
      const message = createMockMemory({
        content: {
          text: 'Remove John Doe from my contacts',
        },
      });

      mockRuntime.useModel.mockResolvedValue(`
        <response>
          <contactName>John Doe</contactName>
          <confirmed>no</confirmed>
        </response>
      `);

      await removeContactAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

      expect(mockRolodexService.removeContact).not.toHaveBeenCalled();
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('please confirm'),
        })
      );
    });

    it('should remove contact when confirmed', async () => {
      const message = createMockMemory({
        content: {
          text: 'Yes, remove John Doe',
        },
      });

      mockRuntime.useModel.mockResolvedValue(`
        <response>
          <contactName>John Doe</contactName>
          <confirmed>yes</confirmed>
        </response>
      `);

      mockRolodexService.searchContacts.mockResolvedValue([
        {
          entityId: stringToUuid('john-doe'),
          categories: ['friend'],
          tags: [],
          preferences: {},
          customFields: {},
          privacyLevel: 'private',
          lastModified: new Date().toISOString(),
        },
      ]);

      await removeContactAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

      expect(mockRolodexService.removeContact).toHaveBeenCalledWith(stringToUuid('john-doe'));
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('removed John Doe'),
          action: 'REMOVE_CONTACT',
        })
      );
    });
  });

  describe('scheduleFollowUpAction', () => {
    it('should validate schedule intent', async () => {
      const message = createMockMemory({
        content: {
          text: 'Schedule a follow-up with Sarah tomorrow',
        },
      });

      const isValid = await scheduleFollowUpAction.validate(mockRuntime, message);
      expect(isValid).toBe(true);
    });

    it('should schedule follow-up successfully', async () => {
      const message = createMockMemory({
        content: {
          text: 'Remind me to follow up with Sarah next week about the project',
        },
      });

      const state = createMockState({
        extractedContactName: 'Sarah',
      });

      const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      mockRuntime.useModel.mockResolvedValue(`
        <response>
          <contactName>Sarah</contactName>
          <scheduledAt>${nextWeek.toISOString()}</scheduledAt>
          <reason>project discussion</reason>
          <priority>medium</priority>
        </response>
      `);

      // Mock that Sarah is already a contact
      mockRolodexService.searchContacts.mockResolvedValue([
        {
          entityId: stringToUuid('sarah'),
          categories: ['colleague'],
          tags: [],
          preferences: {},
          customFields: {},
          privacyLevel: 'private',
          lastModified: new Date().toISOString(),
        },
      ]);

      // Mock that Sarah exists in rolodex
      mockRolodexService.getContact.mockResolvedValue({
        entityId: stringToUuid('sarah'),
        categories: ['colleague'],
        tags: [],
        preferences: {},
        customFields: {},
        privacyLevel: 'private',
        lastModified: new Date().toISOString(),
      });

      // Update the mock to set extractedContactName for findEntityByName
      (mockFindEntityByName as any).mockImplementationOnce(async () => {
        return createMockEntity('Sarah', stringToUuid('sarah'));
      });

      await scheduleFollowUpAction.handler(mockRuntime, message, state, undefined, mockCallback);

      expect(mockFollowUpService.scheduleFollowUp).toHaveBeenCalledWith(
        stringToUuid('sarah'),
        expect.any(Date),
        'project discussion',
        'medium',
        undefined // No message provided
      );
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('scheduled a follow-up with Sarah'),
          action: 'SCHEDULE_FOLLOW_UP',
        })
      );
    });
  });

  describe('searchContactsAction', () => {
    it('should validate search intent', async () => {
      const message = createMockMemory({
        content: {
          text: 'Show me all my VIP contacts',
        },
      });

      const isValid = await searchContactsAction.validate(mockRuntime, message);
      expect(isValid).toBe(true);
    });

    it('should search and display contacts', async () => {
      const message = createMockMemory({
        content: {
          text: 'List all my friends',
        },
      });

      mockRuntime.useModel.mockResolvedValue(`
        <response>
          <categories>friend</categories>
        </response>
      `);

      mockRolodexService.searchContacts.mockResolvedValue([
        {
          entityId: stringToUuid('john'),
          categories: ['friend'],
          tags: [],
          preferences: {},
          customFields: {},
          privacyLevel: 'private',
          lastModified: new Date().toISOString(),
        },
        {
          entityId: stringToUuid('sarah'),
          categories: ['friend', 'vip'],
          tags: ['tech'],
          preferences: {},
          customFields: {},
          privacyLevel: 'private',
          lastModified: new Date().toISOString(),
        },
      ]);

      let callCount = 0;
      mockRuntime.getEntityById = mock(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ id: stringToUuid('john'), names: ['John Doe'], metadata: {} });
        } else {
          return Promise.resolve({ id: stringToUuid('sarah'), names: ['Sarah Smith'], metadata: {} });
        }
      });

      await searchContactsAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

      // The action only sends categories, not tags
      expect(mockRolodexService.searchContacts).toHaveBeenCalledWith({
        categories: ['friend'],
      });
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Your friends'),
          action: 'SEARCH_CONTACTS',
        })
      );
    });
  });
});
