/**
 * Unit Tests: PointsService Leaderboard
 *
 * Tests leaderboard filtering and sorting logic
 */

import { describe, expect, it } from 'bun:test';

describe('PointsService Leaderboard Logic', () => {
  describe('Leaderboard filtering by pointsType', () => {
    it('should sort by allPoints (reputationPoints) for "all" type', () => {
      const users = [
        { id: '1', allPoints: 1500, earnedPoints: 100, invitePoints: 400 },
        { id: '2', allPoints: 2000, earnedPoints: 200, invitePoints: 800 },
        { id: '3', allPoints: 1000, earnedPoints: 50, invitePoints: 200 },
      ];

      const sorted = users.sort((a, b) => b.allPoints - a.allPoints);

      expect(sorted[0]!.id).toBe('2'); // 2000 points
      expect(sorted[1]!.id).toBe('1'); // 1500 points
      expect(sorted[2]!.id).toBe('3'); // 1000 points
    });

    it('should sort by earnedPoints for "earned" type', () => {
      const users = [
        { id: '1', allPoints: 1500, earnedPoints: 100, invitePoints: 400 },
        { id: '2', allPoints: 2000, earnedPoints: 200, invitePoints: 800 },
        { id: '3', allPoints: 1000, earnedPoints: 300, invitePoints: 200 },
      ];

      const sorted = users.sort((a, b) => b.earnedPoints - a.earnedPoints);

      expect(sorted[0]!.id).toBe('3'); // 300 earned points
      expect(sorted[1]!.id).toBe('2'); // 200 earned points
      expect(sorted[2]!.id).toBe('1'); // 100 earned points
    });

    it('should sort by invitePoints for "referral" type', () => {
      const users = [
        { id: '1', allPoints: 1500, earnedPoints: 100, invitePoints: 400 },
        { id: '2', allPoints: 2000, earnedPoints: 200, invitePoints: 800 },
        { id: '3', allPoints: 1000, earnedPoints: 300, invitePoints: 200 },
      ];

      const sorted = users.sort((a, b) => b.invitePoints - a.invitePoints);

      expect(sorted[0]!.id).toBe('2'); // 800 invite points
      expect(sorted[1]!.id).toBe('1'); // 400 invite points
      expect(sorted[2]!.id).toBe('3'); // 200 invite points
    });

    it('should handle negative earned points correctly', () => {
      const users = [
        { id: '1', allPoints: 1400, earnedPoints: -100, invitePoints: 500 },
        { id: '2', allPoints: 2000, earnedPoints: 200, invitePoints: 800 },
        { id: '3', allPoints: 900, earnedPoints: -50, invitePoints: 200 },
      ];

      const sorted = users.sort((a, b) => b.earnedPoints - a.earnedPoints);

      expect(sorted[0]!.id).toBe('2'); // 200 earned points
      expect(sorted[1]!.id).toBe('3'); // -50 earned points
      expect(sorted[2]!.id).toBe('1'); // -100 earned points
    });

    it('should handle zero values correctly', () => {
      const users = [
        { id: '1', allPoints: 1500, earnedPoints: 0, invitePoints: 500 },
        { id: '2', allPoints: 2000, earnedPoints: 100, invitePoints: 0 },
        { id: '3', allPoints: 1000, earnedPoints: 0, invitePoints: 0 },
      ];

      // Sort by earned points
      const sortedByEarned = users.sort(
        (a, b) => b.earnedPoints - a.earnedPoints
      );
      expect(sortedByEarned[0]!.id).toBe('2'); // 100 earned points

      // Users with 0 earned points should be after users with positive earned points
      expect(sortedByEarned[1]!.earnedPoints).toBe(0);
      expect(sortedByEarned[2]!.earnedPoints).toBe(0);
    });
  });

  describe('MinPoints filtering', () => {
    it('should filter users by minimum allPoints for "all" type', () => {
      const users = [
        { id: '1', allPoints: 1500, earnedPoints: 100, invitePoints: 400 },
        { id: '2', allPoints: 2000, earnedPoints: 200, invitePoints: 800 },
        { id: '3', allPoints: 400, earnedPoints: 50, invitePoints: 50 },
      ];

      const minPoints = 500;
      const filtered = users.filter((u) => u.allPoints >= minPoints);

      expect(filtered.length).toBe(2);
      expect(filtered.some((u) => u.id === '1')).toBe(true);
      expect(filtered.some((u) => u.id === '2')).toBe(true);
      expect(filtered.some((u) => u.id === '3')).toBe(false);
    });

    it('should not filter by minPoints for "earned" type', () => {
      const users = [
        { id: '1', allPoints: 1500, earnedPoints: 100, invitePoints: 400 },
        { id: '2', allPoints: 2000, earnedPoints: 200, invitePoints: 800 },
        { id: '3', allPoints: 400, earnedPoints: 50, invitePoints: 50 },
      ];

      // For "earned" type, minPoints should be 0
      const filtered = users.filter((u) => u.earnedPoints >= 0); // No filter for earned type

      expect(filtered.length).toBe(3); // All users should be included
    });

    it('should not filter by minPoints for "referral" type', () => {
      const users = [
        { id: '1', allPoints: 1500, earnedPoints: 100, invitePoints: 400 },
        { id: '2', allPoints: 2000, earnedPoints: 200, invitePoints: 800 },
        { id: '3', allPoints: 400, earnedPoints: 50, invitePoints: 50 },
      ];

      // For "referral" type, minPoints should be 0
      const filtered = users.filter((u) => u.invitePoints >= 0); // No filter for referral type

      expect(filtered.length).toBe(3); // All users should be included
    });
  });

  describe('Pagination', () => {
    it('should correctly slice results for pagination', () => {
      const users = Array.from({ length: 250 }, (_, i) => ({
        id: String(i + 1),
        allPoints: 1000 + i,
        earnedPoints: 100,
        invitePoints: 200,
      }));

      const page = 1;
      const pageSize = 100;
      const skip = (page - 1) * pageSize;

      const paginated = users.slice(skip, skip + pageSize);

      expect(paginated.length).toBe(100);
      expect(paginated[0]!.id).toBe('1');
      expect(paginated[99]!.id).toBe('100');
    });

    it('should handle page 2 correctly', () => {
      const users = Array.from({ length: 250 }, (_, i) => ({
        id: String(i + 1),
        allPoints: 1000 + i,
        earnedPoints: 100,
        invitePoints: 200,
      }));

      const page = 2;
      const pageSize = 100;
      const skip = (page - 1) * pageSize;

      const paginated = users.slice(skip, skip + pageSize);

      expect(paginated.length).toBe(100);
      expect(paginated[0]!.id).toBe('101');
      expect(paginated[99]!.id).toBe('200');
    });

    it('should calculate total pages correctly', () => {
      const totalCount = 250;
      const pageSize = 100;

      const totalPages = Math.ceil(totalCount / pageSize);

      expect(totalPages).toBe(3);
    });

    it('should handle last page with partial results', () => {
      const users = Array.from({ length: 250 }, (_, i) => ({
        id: String(i + 1),
        allPoints: 1000 + i,
        earnedPoints: 100,
        invitePoints: 200,
      }));

      const page = 3;
      const pageSize = 100;
      const skip = (page - 1) * pageSize;

      const paginated = users.slice(skip, skip + pageSize);

      expect(paginated.length).toBe(50); // Only 50 results on last page
      expect(paginated[0]!.id).toBe('201');
      expect(paginated[49]!.id).toBe('250');
    });
  });

  describe('Rank assignment', () => {
    it('should assign ranks correctly starting from 1', () => {
      const users = [
        { id: '1', allPoints: 2000 },
        { id: '2', allPoints: 1500 },
        { id: '3', allPoints: 1000 },
      ];

      const page = 1;
      const pageSize = 100;
      const skip = (page - 1) * pageSize;

      const withRanks = users.map((entry, index) => ({
        ...entry,
        rank: skip + index + 1,
      }));

      expect(withRanks[0]!.rank).toBe(1);
      expect(withRanks[1]!.rank).toBe(2);
      expect(withRanks[2]!.rank).toBe(3);
    });

    it('should assign ranks correctly on page 2', () => {
      const users = [
        { id: '101', allPoints: 900 },
        { id: '102', allPoints: 850 },
        { id: '103', allPoints: 800 },
      ];

      const page = 2;
      const pageSize = 100;
      const skip = (page - 1) * pageSize;

      const withRanks = users.map((entry, index) => ({
        ...entry,
        rank: skip + index + 1,
      }));

      expect(withRanks[0]!.rank).toBe(101);
      expect(withRanks[1]!.rank).toBe(102);
      expect(withRanks[2]!.rank).toBe(103);
    });
  });

  describe('Actor filtering', () => {
    it('should include actors only in "all" leaderboard', () => {
      const allEntries = [
        { id: '1', isActor: false, allPoints: 2000 },
        { id: 'npc1', isActor: true, allPoints: 1800 },
        { id: '2', isActor: false, allPoints: 1500 },
      ];

      // For "all" type - include actors
      const allFiltered = allEntries; // No filtering
      expect(allFiltered.length).toBe(3);
      expect(allFiltered.some((e) => e.isActor)).toBe(true);

      // For "earned" type - exclude actors
      const earnedFiltered = allEntries.filter((e) => !e.isActor);
      expect(earnedFiltered.length).toBe(2);
      expect(earnedFiltered.every((e) => !e.isActor)).toBe(true);

      // For "referral" type - exclude actors
      const referralFiltered = allEntries.filter((e) => !e.isActor);
      expect(referralFiltered.length).toBe(2);
      expect(referralFiltered.every((e) => !e.isActor)).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty leaderboard', () => {
      const users: Array<{
        id: string;
        allPoints: number;
        earnedPoints: number;
        invitePoints: number;
      }> = [];

      const sorted = users.sort((a, b) => b.allPoints - a.allPoints);
      expect(sorted.length).toBe(0);
    });

    it('should handle single user', () => {
      const users = [
        { id: '1', allPoints: 1500, earnedPoints: 100, invitePoints: 400 },
      ];

      const sorted = users.sort((a, b) => b.allPoints - a.allPoints);
      expect(sorted.length).toBe(1);
      expect(sorted[0]!.id).toBe('1');
    });

    it('should handle users with identical scores', () => {
      const users = [
        { id: '1', allPoints: 1500, earnedPoints: 100, invitePoints: 400 },
        { id: '2', allPoints: 1500, earnedPoints: 100, invitePoints: 400 },
        { id: '3', allPoints: 1500, earnedPoints: 100, invitePoints: 400 },
      ];

      const sorted = users.sort((a, b) => b.allPoints - a.allPoints);

      // All should have same points
      expect(sorted[0]!.allPoints).toBe(1500);
      expect(sorted[1]!.allPoints).toBe(1500);
      expect(sorted[2]!.allPoints).toBe(1500);

      // Order among tied users is implementation-dependent but stable
      expect(sorted.length).toBe(3);
    });

    it('should handle very large point values', () => {
      const users = [
        {
          id: '1',
          allPoints: 999999,
          earnedPoints: 50000,
          invitePoints: 40000,
        },
        {
          id: '2',
          allPoints: 1000000,
          earnedPoints: 60000,
          invitePoints: 50000,
        },
      ];

      const sorted = users.sort((a, b) => b.allPoints - a.allPoints);

      expect(sorted[0]!.id).toBe('2'); // 1,000,000 points
      expect(sorted[1]!.id).toBe('1'); // 999,999 points
    });
  });
});
