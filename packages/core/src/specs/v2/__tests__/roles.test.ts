import { describe, it, expect } from 'bun:test';
import { getUserServerRole, findWorldsForOwner } from '../roles';
import { Role } from '../types';

describe('roles utilities', () => {
  const runtime = {
    getWorld: async (id: string) => ({ id, metadata: { roles: { user: Role.ADMIN } } }),
    getAllWorlds: async () => [
      { metadata: { ownership: { ownerId: 'owner1' } } },
      { metadata: { ownership: { ownerId: 'other' } } },
    ],
  } as any;

  it('getUserServerRole returns role from world metadata', async () => {
    const role = await getUserServerRole(runtime, 'user', 'server');
    expect(role).toBe(Role.ADMIN);
  });

  it('findWorldsForOwner finds owned worlds', async () => {
    const worlds = await findWorldsForOwner(runtime, 'owner1');
    expect(worlds?.length).toBe(1);
  });
});
