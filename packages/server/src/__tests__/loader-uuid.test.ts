import { describe, expect, it } from 'bun:test';
import { jsonToCharacter } from '../loader';
import type { Character } from '@elizaos/core';

/**
 * Test suite to verify that the character loader generates deterministic UUIDs from names.
 * This ensures backward compatibility and predictable environment variable naming.
 */
describe('Character Loader - UUID Generation', () => {
  it('should generate deterministic UUID from name when ID not provided', async () => {
    const characterData = {
      name: 'TestAgent',
      bio: ['A test agent'],
    };

    const character = await jsonToCharacter(characterData);

    expect(character.id).toBeTruthy();
    expect(character.name).toBe('TestAgent');

    // Verify it's a valid UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(uuidRegex.test(character.id!)).toBe(true);
  });

  it('should generate same deterministic UUID for characters with same name', async () => {
    const characterData1 = {
      name: 'DuplicateName',
      bio: ['First agent'],
    };

    const characterData2 = {
      name: 'DuplicateName',
      bio: ['Second agent'],
    };

    const character1 = await jsonToCharacter(characterData1);
    const character2 = await jsonToCharacter(characterData2);

    expect(character1.id).toBeTruthy();
    expect(character2.id).toBeTruthy();
    // Deterministic UUIDs from same name should be identical
    expect(character1.id).toBe(character2.id);
    expect(character1.name).toBe(character2.name);
  });

  it('should preserve existing ID if provided', async () => {
    const explicitId = '12345678-1234-1234-1234-123456789012';
    const characterData = {
      id: explicitId,
      name: 'TestAgent',
      bio: ['Agent with explicit ID'],
    };

    const character = await jsonToCharacter(characterData);

    expect(character.id).toBe(explicitId);
    expect(character.name).toBe('TestAgent');
  });

  it('should derive deterministic UUID from name for backward compatibility', async () => {
    const characterName = 'SpecificName';
    const characterData1 = {
      name: characterName,
      bio: ['First agent'],
    };

    const characterData2 = {
      name: characterName,
      bio: ['Second agent'],
    };

    const character1 = await jsonToCharacter(characterData1);
    const character2 = await jsonToCharacter(characterData2);

    // UUIDs derived from same name should be identical (deterministic)
    // This enables backward compatibility and predictable environment variables
    expect(character1.id).toBe(character2.id);
    expect(character1.name).toBe(characterName);
    expect(character2.name).toBe(characterName);
  });

  it('should handle array of characters with duplicate names consistently', async () => {
    const characters: Character[] = [];
    const sharedName = 'ClonedAgent';

    // Create 5 characters with the same name
    for (let i = 0; i < 5; i++) {
      const characterData = {
        name: sharedName,
        bio: [`Clone number ${i + 1}`],
      };
      const character = await jsonToCharacter(characterData);
      characters.push(character);
    }

    // Verify all have IDs
    expect(characters.every((c) => c.id)).toBe(true);

    // Verify all have the same name
    expect(characters.every((c) => c.name === sharedName)).toBe(true);

    // Verify all have the SAME ID (deterministic from name)
    const ids = characters.map((c) => c.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(1); // All should have the same deterministic UUID
  });

  it('should generate deterministic UUIDs from name consistently', async () => {
    const iterations = 10;
    const results: string[] = [];
    const characterName = 'SameName';

    // Generate multiple characters with the same name
    for (let i = 0; i < iterations; i++) {
      const character = await jsonToCharacter({
        name: characterName,
        bio: [`Iteration ${i}`],
      });
      results.push(character.id!);
    }

    // All IDs should be identical (deterministic from name)
    const uniqueIds = new Set(results);
    expect(uniqueIds.size).toBe(1);

    // All should be the same name
    const characters = await Promise.all(
      results.map((id) =>
        jsonToCharacter({
          id,
          name: characterName,
          bio: [],
        })
      )
    );
    expect(characters.every((c) => c.name === characterName)).toBe(true);
  });

  it('should support different IDs for same name when explicitly provided', async () => {
    const sharedName = 'SharedName';
    const explicitId1 = '11111111-1111-1111-1111-111111111111';
    const explicitId2 = '22222222-2222-2222-2222-222222222222';

    const character1 = await jsonToCharacter({
      id: explicitId1,
      name: sharedName,
      bio: ['First agent with explicit ID'],
    });

    const character2 = await jsonToCharacter({
      id: explicitId2,
      name: sharedName,
      bio: ['Second agent with explicit ID'],
    });

    // When IDs are explicitly provided, they should be preserved
    expect(character1.id).toBe(explicitId1);
    expect(character2.id).toBe(explicitId2);
    expect(character1.id).not.toBe(character2.id);
    expect(character1.name).toBe(sharedName);
    expect(character2.name).toBe(sharedName);
  });
});
