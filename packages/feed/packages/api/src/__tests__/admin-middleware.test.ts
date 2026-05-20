import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockSelect = mock();
const mockLoggerInfo = mock();
const mockLoggerWarn = mock();

const adminRolesTable = { table: 'adminRoles' };
const usersTable = { table: 'users' };

mock.module('@feed/db', () => ({
  adminRoles: adminRolesTable,
  and: (...conditions: unknown[]) => ({ conditions }),
  db: {
    select: mockSelect,
  },
  eq: (left: unknown, right: unknown) => ({ left, right }),
  isNull: (value: unknown) => ({ value }),
  notInArray: (left: unknown, right: unknown[]) => ({ left, right }),
  ROLE_PERMISSIONS: {
    SUPER_ADMIN: ['manage_admins', 'manage_game', 'manage_escrow'],
    ADMIN: ['view_stats', 'manage_users'],
    VIEWER: ['view_stats'],
  },
  users: usersTable,
}));

mock.module('@feed/shared', () => ({
  checkForAdminEmail: () => ({ adminEmail: null, allVerifiedEmails: [] }),
  logger: {
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
  },
}));

mock.module('../auth-middleware', () => ({
  authenticate: mock(),
}));

import { ROLE_PERMISSIONS } from '@feed/db';
import { getAdminRole, getAllAdmins } from '../admin-middleware';

describe('admin-middleware role mapping', () => {
  beforeEach(() => {
    mockSelect.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
    process.env.ADMIN_EMAIL_DOMAIN = '';
  });

  it('maps legacy isAdmin users to ADMIN in getAdminRole', async () => {
    mockSelect
      .mockImplementationOnce(() => ({
        from: (table: unknown) => {
          expect(table).toBe(adminRolesTable);
          return {
            where: () => ({
              limit: async () => [],
            }),
          };
        },
      }))
      .mockImplementationOnce(() => ({
        from: (table: unknown) => {
          expect(table).toBe(usersTable);
          return {
            where: () => ({
              limit: async () => [{ isAdmin: true, privyId: null }],
            }),
          };
        },
      }));

    const result = await getAdminRole('legacy-user-id');

    expect(result.role).toBe('ADMIN');
    expect(result.permissions).toEqual(ROLE_PERMISSIONS.ADMIN);
  });

  it('maps legacy isAdmin users to ADMIN in getAllAdmins', async () => {
    mockSelect
      .mockImplementationOnce(() => ({
        from: (table: unknown) => {
          expect(table).toBe(adminRolesTable);
          return {
            innerJoin: () => ({
              where: async () => [],
            }),
          };
        },
      }))
      .mockImplementationOnce(() => ({
        from: (table: unknown) => {
          expect(table).toBe(usersTable);
          return {
            where: async () => [
              {
                id: 'legacy-user-id',
                username: 'legacy-user',
                displayName: 'Legacy User',
                profileImageUrl: null,
                createdAt: new Date('2026-01-01T00:00:00.000Z'),
              },
            ],
          };
        },
      }));

    const result = await getAllAdmins();

    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe('ADMIN');
    expect(result[0]?.permissions).toEqual(ROLE_PERMISSIONS.ADMIN);
  });
});
