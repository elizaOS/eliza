import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase, clearDatabase } from '../test-utils';
import { patchComponent } from '../stores/component.store';
import { v4 as uuidv4 } from 'uuid';

describe('RLS Entity Tests', () => {
  let db;
  const componentId = uuidv4();

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await clearDatabase(db);
  });

  test('properly handles RLS for components', async () => {
    // Add relevant component creation/insertion logic if needed

    const ops = [{ op: 'set', path: 'config.enabled', value: true }];
    await patchComponent(db, componentId, ops);
    const component = await db.getComponent(componentId);
    expect(component.data.config.enabled).toBe(true);

    // Add any additional RLS specific checks
  });
});
