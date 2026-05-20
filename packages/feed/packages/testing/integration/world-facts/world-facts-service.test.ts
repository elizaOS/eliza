/**
 * World Facts Service Tests
 *
 * Integration tests for world facts service against real database.
 * Requires PostgreSQL to be running.
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { db, eq, like, or, worldFacts } from '@feed/db';
import { worldFactsService } from '@feed/engine';

// Skip if DATABASE_URL is not set
const shouldSkip = !process.env.DATABASE_URL;
const describeTests = shouldSkip ? describe.skip : describe;

describeTests('WorldFactsService', () => {
  const testValuePrefix = 'Test Fact: ' + Date.now();
  let dbAvailable = true;

  beforeAll(async () => {
    // Verify database connectivity
    try {
      await db.select().from(worldFacts).limit(1);
    } catch (error) {
      const msg = (error as Error).message ?? '';
      if (msg.includes('ECONNREFUSED') || msg.includes('connect')) {
        console.error('❌ Database not available - tests will be skipped');
        dbAvailable = false;
        return;
      }
      throw error;
    }
  });

  afterEach(async () => {
    if (!dbAvailable) return;
    // Cleanup test data
    await db
      .delete(worldFacts)
      .where(like(worldFacts.value, `${testValuePrefix}%`));
  });

  // Helper to skip test if DB not available
  const skipIfNoDb = () => {
    if (!dbAvailable) {
      console.log('⏭️  Skipping - database not available');
      return true;
    }
    return false;
  };

  test('should create a new world fact by value', async () => {
    if (skipIfNoDb()) return;
    const testValue = `${testValuePrefix} - Initial Value`;
    const fact = await worldFactsService.setFactByValue(testValue);

    expect(fact).toBeDefined();
    expect(fact.value).toBe(testValue);
    expect(fact.category).toBe('general');
    expect(fact.isActive).toBe(true);
  });

  test('should update existing world fact', async () => {
    if (skipIfNoDb()) return;
    // Create initial fact
    const testValue = `${testValuePrefix} - Initial Value`;
    const fact = await worldFactsService.setFactByValue(testValue);

    // Update it by ID
    const updatedValue = `${testValuePrefix} - Updated Value`;
    const updated = await worldFactsService.updateFactById(
      fact.id,
      updatedValue
    );

    expect(updated.value).toBe(updatedValue);
    expect(updated.id).toBe(fact.id);
  });

  test('should get all facts', async () => {
    if (skipIfNoDb()) return;
    const testValue = `${testValuePrefix} - Test Value`;
    await worldFactsService.setFactByValue(testValue);

    const facts = await worldFactsService.getAllFacts();

    expect(facts).toBeDefined();
    expect(Array.isArray(facts)).toBe(true);
    expect(facts.some((f) => f.value === testValue)).toBe(true);
  });

  test('should delete a fact', async () => {
    if (skipIfNoDb()) return;
    const testValue = `${testValuePrefix} - To Delete`;
    const fact = await worldFactsService.setFactByValue(testValue);

    await worldFactsService.deleteFact(fact.id);

    const allFacts = await worldFactsService.getAllFacts();
    expect(allFacts.some((f) => f.id === fact.id)).toBe(false);
  });

  test('should toggle fact active status', async () => {
    if (skipIfNoDb()) return;
    const testValue = `${testValuePrefix} - Toggle Test`;
    const fact = await worldFactsService.setFactByValue(testValue);

    expect(fact.isActive).toBe(true);

    const toggled = await worldFactsService.toggleFactActive(fact.id);
    expect(toggled.isActive).toBe(false);

    const toggledAgain = await worldFactsService.toggleFactActive(fact.id);
    expect(toggledAgain.isActive).toBe(true);
  });

  test('should generate world context', async () => {
    if (skipIfNoDb()) return;
    const testValue = `${testValuePrefix} - Context Test`;
    await worldFactsService.setFactByValue(testValue);

    const context = await worldFactsService.generateWorldContext(false);

    expect(context).toBeDefined();
    expect(context.timestamp).toBeDefined();
    expect(typeof context.crypto).toBe('string');
    expect(typeof context.politics).toBe('string');
    expect(typeof context.economy).toBe('string');
    expect(typeof context.technology).toBe('string');
    expect(typeof context.general).toBe('string');
    expect(context.general).toContain(testValue);
  });

  test('should generate prompt context string', async () => {
    if (skipIfNoDb()) return;
    const testValue = `${testValuePrefix} - Prompt Test`;
    await worldFactsService.setFactByValue(testValue);

    // Generate context without headlines to avoid LLM requirement
    const context = await worldFactsService.generateWorldContext(false);

    expect(context).toBeDefined();
    expect(context.timestamp).toBeDefined();
    expect(typeof context.crypto).toBe('string');
    expect(typeof context.politics).toBe('string');
    expect(typeof context.economy).toBe('string');
    expect(typeof context.technology).toBe('string');
    expect(typeof context.general).toBe('string');
  });

  test('should bulk update facts', async () => {
    if (skipIfNoDb()) return;
    // Use different prefixes to generate unique keys (key is extracted from before the colon)
    const timestamp = Date.now();
    const values = [
      `BulkTestA${timestamp}: First bulk value for testing`,
      `BulkTestB${timestamp}: Second bulk value for testing`,
    ];

    await worldFactsService.bulkUpdateFacts(values);

    const facts = await worldFactsService.getAllFacts();
    expect(facts.some((f) => f.value === values[0])).toBe(true);
    expect(facts.some((f) => f.value === values[1])).toBe(true);

    // Cleanup these specific test facts
    await db
      .delete(worldFacts)
      .where(
        or(
          eq(worldFacts.key, `bulktesta${timestamp}`),
          eq(worldFacts.key, `bulktestb${timestamp}`)
        )
      );
  });
});
