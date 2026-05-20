/**
 * Character Mapping Service Unit Tests
 *
 * Tests word-to-word mapping logic to ensure:
 * - "Arthur Hayes" → "Arthur HAIyes" (full name)
 * - "Hayes" → "HAIyes" (just the last name, NOT "Arthur HAIyes")
 * - "Elon Musk" → "AIlon Musk" (full name)
 * - "Elon" → "AIlon" (just the first name)
 * - "Musk" → "Musk" (unchanged if same in parody)
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { CharacterMappingService } from '@babylon/engine';

// Mock database to avoid database dependency
const mockCharacterMappings = [
  {
    id: '1',
    realName: 'Arthur Hayes',
    parodyName: 'Arthur HAIyes',
    category: 'crypto',
    aliases: ['Hayes', 'Arthur'],
    isActive: true,
    priority: 10,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: '2',
    realName: 'Elon Musk',
    parodyName: 'AIlon Musk',
    category: 'tech',
    aliases: ['Elon', 'Musk'],
    isActive: true,
    priority: 10,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: '3',
    realName: 'Sam Altman',
    parodyName: 'Sam AIltman',
    category: 'tech',
    aliases: ['Altman', 'Sam'],
    isActive: true,
    priority: 10,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: '4',
    realName: 'Frank DeGods',
    parodyName: 'FrAInk DeGods',
    category: 'nft',
    aliases: ['Frank', 'DeGods'],
    isActive: true,
    priority: 10,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

const mockOrganizationMappings = [
  {
    id: '1',
    realName: 'Tesla',
    parodyName: 'TeslAI',
    category: 'tech',
    aliases: [],
    isActive: true,
    priority: 10,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: '2',
    realName: 'OpenAI',
    parodyName: 'OpenAGI',
    category: 'tech',
    aliases: [],
    isActive: true,
    priority: 10,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

// Create a testable version of the service with injected mappings
class TestableCharacterMappingService extends CharacterMappingService {
  setMockMappings(
    characters: typeof mockCharacterMappings,
    organizations: typeof mockOrganizationMappings
  ) {
    // Access private properties for testing
    // Type assertion needed to access private properties for testing purposes
    // Use 'as unknown as' to bypass TypeScript's intersection type reduction to 'never'
    type TestableService = {
      characterMappingsCache: typeof mockCharacterMappings;
      organizationMappingsCache: typeof mockOrganizationMappings;
      initialized: boolean;
    };
    const self = this as unknown as TestableService;
    self.characterMappingsCache = characters;
    self.organizationMappingsCache = organizations;
    self.initialized = true;
  }
}

describe('CharacterMappingService', () => {
  test('should be defined', () => {
    const service = new CharacterMappingService();
    expect(service).toBeDefined();
  });

  test('service should have expected structure', () => {
    const service = new CharacterMappingService();
    expect(service).toBeDefined();
    expect(typeof service).toBe('object');
  });
});

describe('Word-to-Word Mapping', () => {
  let service: TestableCharacterMappingService;

  beforeEach(() => {
    service = new TestableCharacterMappingService();
    service.setMockMappings(mockCharacterMappings, mockOrganizationMappings);
  });

  test('should replace full name with full parody name', async () => {
    const result = await service.transformText('Arthur Hayes is speaking');
    expect(result.transformedText).toBe('Arthur HAIyes is speaking');
    expect(result.replacementCount).toBe(1);
  });

  test('should replace last name with ONLY parody last name (not full name)', async () => {
    // This is the key test - "Hayes" should become "HAIyes", NOT "Arthur HAIyes"
    const result = await service.transformText('Hayes is speaking');
    expect(result.transformedText).toBe('HAIyes is speaking');
    expect(result.replacementCount).toBe(1);
  });

  test('should replace first name with ONLY parody first name', async () => {
    const result = await service.transformText('Elon said something');
    expect(result.transformedText).toBe('AIlon said something');
    expect(result.replacementCount).toBe(1);
  });

  test('should handle unchanged last name correctly', async () => {
    // Musk → Musk (same in parody), should not double-replace
    const result = await service.transformText('Musk tweeted');
    // "Musk" maps to "Musk" (unchanged), so no replacement needed
    expect(result.transformedText).toBe('Musk tweeted');
  });

  test('should handle multiple different names in same text', async () => {
    const result = await service.transformText('Hayes and Elon met');
    expect(result.transformedText).toBe('HAIyes and AIlon met');
    expect(result.replacementCount).toBe(2);
  });

  test('should not double-replace already correct parody names', async () => {
    // If text already has "Arthur HAIyes", don't try to replace "Hayes" with "HAIyes" again
    const result = await service.transformText('Arthur HAIyes is great');
    expect(result.transformedText).toBe('Arthur HAIyes is great');
    expect(result.replacementCount).toBe(0);
  });

  test('should handle Frank DeGods word mapping', async () => {
    // Frank → FrAInk, DeGods → DeGods
    const result = await service.transformText('Frank announced something');
    expect(result.transformedText).toBe('FrAInk announced something');
  });

  test('should handle Sam Altman word mapping', async () => {
    // Sam → Sam (unchanged), Altman → AIltman
    const result = await service.transformText(
      'Altman spoke at the conference'
    );
    expect(result.transformedText).toBe('AIltman spoke at the conference');
  });

  test('should replace organizations correctly', async () => {
    const result = await service.transformText('Tesla stock is up');
    expect(result.transformedText).toBe('TeslAI stock is up');
  });

  test('should handle mixed character and organization replacements', async () => {
    const result = await service.transformText('Elon sold Tesla stock');
    expect(result.transformedText).toBe('AIlon sold TeslAI stock');
    expect(result.replacementCount).toBe(2);
  });

  test('should preserve punctuation around names', async () => {
    const result = await service.transformText('Hayes, the CEO, spoke.');
    expect(result.transformedText).toBe('HAIyes, the CEO, spoke.');
  });

  test('should handle @mentions with full username', async () => {
    // @arthurhayes is the real username, should become @arthurhaiyes
    const result = await service.transformText('@arthurhayes posted');
    expect(result.transformedText).toBe('@arthurhaiyes posted');
  });
});

describe('Username Mapping', () => {
  let service: TestableCharacterMappingService;

  beforeEach(() => {
    service = new TestableCharacterMappingService();
    service.setMockMappings(mockCharacterMappings, mockOrganizationMappings);
  });

  test('should replace @elonmusk with @ailonmusk', async () => {
    const result = await service.transformText('@elonmusk tweeted');
    expect(result.transformedText).toBe('@ailonmusk tweeted');
  });

  test('should replace @ELONMUSK with @AILONMUSK (uppercase)', async () => {
    const result = await service.transformText('@ELONMUSK tweeted');
    expect(result.transformedText).toBe('@AILONMUSK tweeted');
  });

  test('should replace @arthurhayes with @arthurhaiyes', async () => {
    const result = await service.transformText('@arthurhayes posted');
    expect(result.transformedText).toBe('@arthurhaiyes posted');
  });

  test('should handle multiple @mentions', async () => {
    const result = await service.transformText('@elonmusk and @samaltman met');
    // samaltman → samailtman (Sam stays same, Altman → AIltman)
    expect(result.transformedText).toBe('@ailonmusk and @samailtman met');
  });

  test('should replace usernames before names to avoid conflicts', async () => {
    // @elonmusk → @ailonmusk
    // Then "Elon" won't be replaced because "ailon" is already in text (from @ailonmusk)
    // This is correct behavior - we don't want double-replacement
    const result = await service.transformText('@elonmusk said something');
    expect(result.transformedText).toBe('@ailonmusk said something');
  });

  test('should replace standalone names when username not present', async () => {
    const result = await service.transformText('Elon said something');
    expect(result.transformedText).toBe('AIlon said something');
  });
});

describe('Word Boundary Protection', () => {
  let service: TestableCharacterMappingService;

  beforeEach(() => {
    service = new TestableCharacterMappingService();
    service.setMockMappings(mockCharacterMappings, mockOrganizationMappings);
  });

  test('should NOT match partial words - AIX should stay AIX', async () => {
    // "AIX" is a standalone company name, not "AI" + something
    const result = await service.transformText('AIX stock is up');
    expect(result.transformedText).toBe('AIX stock is up');
    expect(result.replacementCount).toBe(0);
  });

  test('should NOT match partial words - FAIX News should stay FAIX News', async () => {
    // "FAIX" is a parody name, not "AI" + something
    const result = await service.transformText('FAIX News reported');
    expect(result.transformedText).toBe('FAIX News reported');
    expect(result.replacementCount).toBe(0);
  });

  test('should NOT match partial words - OpenAGI should stay OpenAGI', async () => {
    // "OpenAGI" is already a parody name
    const result = await service.transformText('OpenAGI released GPT-5');
    expect(result.transformedText).toBe('OpenAGI released GPT-5');
  });

  test('should NOT match inside compound words', async () => {
    // "TeslAI" shouldn't match "Tesla" inside it
    const result = await service.transformText('TeslAI stock soared');
    expect(result.transformedText).toBe('TeslAI stock soared');
  });

  test('should NOT match name parts inside other names', async () => {
    // If someone is named "AIlonzo", shouldn't match "Elon" alias
    const result = await service.transformText('AIlonzo spoke today');
    expect(result.transformedText).toBe('AIlonzo spoke today');
  });

  test('should match standalone words correctly', async () => {
    // "Tesla" standalone should be replaced
    const result = await service.transformText('Tesla is a company');
    expect(result.transformedText).toBe('TeslAI is a company');
  });

  test('should match words with punctuation boundaries', async () => {
    const result = await service.transformText('Tesla, the company, grew');
    expect(result.transformedText).toBe('TeslAI, the company, grew');
  });
});

describe('Case Preservation', () => {
  let service: TestableCharacterMappingService;

  beforeEach(() => {
    service = new TestableCharacterMappingService();
    service.setMockMappings(mockCharacterMappings, mockOrganizationMappings);
  });

  test('should convert to lowercase when input is all lowercase', async () => {
    const result = await service.transformText('hayes said something');
    expect(result.transformedText).toBe('haiyes said something');
  });

  test('should convert to uppercase when input is all uppercase', async () => {
    const result = await service.transformText('HAYES said something');
    expect(result.transformedText).toBe('HAIYES said something');
  });

  test('should keep parody casing for mixed case input (preserves AI puns)', async () => {
    // "Hayes" is title case, but we keep "HAIyes" to preserve the AI pun
    const result = await service.transformText('Hayes said something');
    expect(result.transformedText).toBe('HAIyes said something');
  });

  test('should convert to lowercase for first names when input is lowercase', async () => {
    const result = await service.transformText('elon tweeted');
    expect(result.transformedText).toBe('ailon tweeted');
  });

  test('should convert to uppercase for first names when input is uppercase', async () => {
    const result = await service.transformText('ELON tweeted');
    expect(result.transformedText).toBe('AILON tweeted');
  });

  test('should keep parody casing for mixed case first names', async () => {
    // "Elon" is title case, but we keep "AIlon" to preserve the AI pun
    const result = await service.transformText('Elon tweeted');
    expect(result.transformedText).toBe('AIlon tweeted');
  });
});
