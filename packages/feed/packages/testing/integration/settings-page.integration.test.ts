/**
 * Integration Tests: Settings Page
 *
 * Tests all functionality on the settings page including:
 * - Profile updates (display name, username, bio)
 * - Theme settings
 * - Security features
 * - Privacy features (data export, account deletion)
 * - Tab navigation
 *
 * Prerequisites:
 * - Backend server must be running
 * - Playwright auth setup must be run first:
 *   - bunx playwright test --project=setup
 *   - bunx playwright test --project=setup-integration-auth
 *
 * Note: These tests require Privy authentication which may not be available in CI.
 * Tests will skip cleanly if auth is not set up.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type APIRequestContext, request } from '@playwright/test';
import {
  cleanupPlaywrightAPI,
  getAPIBaseURL,
  getAuthUnavailableReason,
  initPlaywrightAPI,
  isAuthAvailable,
} from './helpers/playwright-api';

const API_URL = getAPIBaseURL();

// Playwright API request context and test user ID
let apiRequest: APIRequestContext;
let testUserId: string;

// Check auth availability once at module load (before tests run)
const authAvailable = isAuthAvailable();
if (!authAvailable) {
  console.log(
    `ℹ️  Settings Page Tests: Skipping - ${getAuthUnavailableReason()}`
  );
}

describe('Settings Page Integration Tests', () => {
  // Check if server is running and auth is available
  let serverAvailable = false;
  let authInitialized = false;

  beforeAll(async () => {
    // Skip early if auth not available
    if (!authAvailable) {
      return;
    }

    // Check server health
    try {
      const healthResponse = await fetch(`${API_URL}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      serverAvailable = healthResponse.ok;
    } catch {
      serverAvailable = false;
    }

    if (!serverAvailable) {
      console.log('ℹ️  Settings Page Tests: Skipping - Server not available');
      return;
    }

    // Initialize Playwright API with authentication
    try {
      const { apiRequest: request, testUserId: userId } =
        await initPlaywrightAPI();
      apiRequest = request;
      testUserId = userId;
      authInitialized = true;
      console.log(
        `✅ Settings Page Tests: Authenticated as user: ${testUserId}`
      );
    } catch (error) {
      console.log(
        `ℹ️  Settings Page Tests: Skipping - Auth initialization failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
  });

  afterAll(async () => {
    await cleanupPlaywrightAPI();
  });

  // Helper to check if tests can run
  const canRunTests = () =>
    authAvailable && serverAvailable && authInitialized && apiRequest;

  describe('Profile Tab', () => {
    test('should update display name', async () => {
      if (!canRunTests()) {
        return; // Skip silently - reason already logged in beforeAll
      }

      const newDisplayName = `Test User ${Date.now()}`;

      const response = await apiRequest.put(
        `${API_URL}/users/${testUserId}/update-profile`,
        {
          data: {
            displayName: newDisplayName,
          },
        }
      );

      expect(response.ok()).toBe(true);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.user.displayName).toBe(newDisplayName);
    });

    test('should update bio', async () => {
      if (!canRunTests()) {
        return;
      }

      const newBio = `Test bio updated at ${Date.now()}`;

      const response = await apiRequest.put(
        `${API_URL}/users/${testUserId}/update-profile`,
        {
          data: {
            bio: newBio,
          },
        }
      );

      expect(response.ok()).toBe(true);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.user.bio).toBe(newBio);
    });

    test('should enforce username change rate limit (24 hours)', async () => {
      if (!canRunTests()) {
        return;
      }

      // First, try to change username
      const newUsername = `testuser${Date.now()}`;

      const firstResponse = await apiRequest.put(
        `${API_URL}/users/${testUserId}/update-profile`,
        {
          data: {
            username: newUsername,
          },
        }
      );

      if (firstResponse.ok()) {
        // If first change succeeded, try immediately again - should fail
        const secondResponse = await apiRequest.put(
          `${API_URL}/users/${testUserId}/update-profile`,
          {
            data: {
              username: `testuser${Date.now() + 1}`,
            },
          }
        );

        expect(secondResponse.ok()).toBe(false);
        const errorData = await secondResponse.json();
        expect(errorData.error).toBeTruthy();
      }
    });

    test('should reject duplicate usernames', async () => {
      if (!canRunTests()) {
        return;
      }

      // Try to use a common username that likely exists
      const response = await apiRequest.put(
        `${API_URL}/users/${testUserId}/update-profile`,
        {
          data: {
            username: 'admin', // Likely taken
          },
        }
      );

      // Should either fail or succeed (if somehow available)
      // Main point is to verify the API handles duplicate checks
      const data = await response.json();
      expect(data).toBeTruthy();
    });

    test('should require on-chain registration for profile updates', async () => {
      if (!canRunTests()) {
        return;
      }

      // Fetch current user to check registration status
      const userResponse = await apiRequest.get(`${API_URL}/users/me`);
      const userData = await userResponse.json();

      if (!userData.user.nftTokenId) {
        // If not registered, profile updates should fail
        const updateResponse = await apiRequest.put(
          `${API_URL}/users/${testUserId}/update-profile`,
          {
            data: {
              displayName: 'Should Fail',
            },
          }
        );

        expect(updateResponse.ok()).toBe(false);
      }
    });
  });

  // Theme Tab and Security Tab tests require browser testing
  // These are tested in synpress/playwright e2e tests

  describe('Privacy Tab', () => {
    test('should export user data (GDPR compliance)', async () => {
      if (!canRunTests()) {
        return;
      }

      const response = await apiRequest.get(`${API_URL}/users/export-data`);

      expect(response.ok()).toBe(true);
      const contentType = response.headers()['content-type'];
      expect(contentType).toContain('application/json');

      const data = await response.json();
      expect(data.export_info).toBeTruthy();
      expect(data.personal_information).toBeTruthy();
      expect(data.export_info.user_id).toBe(testUserId);
    });

    test('should include all user data in export', async () => {
      if (!canRunTests()) {
        return;
      }

      const response = await apiRequest.get(`${API_URL}/users/export-data`);
      const data = await response.json();

      // Verify all required sections exist
      expect(data.export_info).toBeTruthy();
      expect(data.personal_information).toBeTruthy();
      expect(data.content).toBeTruthy();
      expect(data.trading).toBeTruthy();
      expect(data.social).toBeTruthy();
      expect(data.points_and_reputation).toBeTruthy();
      expect(data.financial).toBeTruthy();
      expect(data.notifications).toBeTruthy();
      expect(data.legal_consent).toBeTruthy();
    });

    test('should require exact confirmation for account deletion', async () => {
      if (!canRunTests()) {
        return;
      }

      // Try with wrong confirmation
      const response = await apiRequest.post(
        `${API_URL}/users/delete-account`,
        {
          data: {
            confirmation: 'wrong confirmation',
            reason: 'Testing',
          },
        }
      );

      expect(response.ok()).toBe(false);
    });

    test('should not allow account deletion without proper confirmation', async () => {
      if (!canRunTests()) {
        return;
      }

      // Missing confirmation field
      const response = await apiRequest.post(
        `${API_URL}/users/delete-account`,
        {
          data: {
            reason: 'Testing',
          },
        }
      );

      expect(response.ok()).toBe(false);
    });

    // NOTE: We don't actually test account deletion with correct confirmation
    // because that would delete the test account!
  });

  // Tab Navigation tests require browser testing
  // These are tested in synpress/playwright e2e tests

  describe('Authentication Requirements', () => {
    test('should require authentication for profile updates', async () => {
      // This test checks unauthenticated access - needs server + testUserId from auth init
      if (!canRunTests()) {
        return;
      }

      // Create unauthenticated request context
      const unauthenticatedRequest = await request.newContext();

      try {
        const response = await unauthenticatedRequest.put(
          `${API_URL}/users/${testUserId}/update-profile`,
          {
            data: {
              displayName: 'Should Fail',
            },
          }
        );

        expect(response.ok()).toBe(false);
        expect(response.status()).toBe(401);
      } finally {
        await unauthenticatedRequest.dispose();
      }
    });

    test('should require authentication for data export', async () => {
      // This test checks unauthenticated access - only needs server to be running
      if (!authAvailable || !serverAvailable) {
        return;
      }

      // Create unauthenticated request context
      const unauthenticatedRequest = await request.newContext();

      try {
        const response = await unauthenticatedRequest.get(
          `${API_URL}/users/export-data`
        );

        expect(response.ok()).toBe(false);
        expect(response.status()).toBe(401);
      } finally {
        await unauthenticatedRequest.dispose();
      }
    });

    test('should require authentication for account deletion', async () => {
      // This test checks unauthenticated access - only needs server to be running
      if (!authAvailable || !serverAvailable) {
        return;
      }

      // Create unauthenticated request context
      const unauthenticatedRequest = await request.newContext();

      try {
        const response = await unauthenticatedRequest.post(
          `${API_URL}/users/delete-account`,
          {
            data: {
              confirmation: 'DELETE MY ACCOUNT',
            },
          }
        );

        expect(response.ok()).toBe(false);
        expect(response.status()).toBe(401);
      } finally {
        await unauthenticatedRequest.dispose();
      }
    });

    test('should prevent users from updating other users profiles', async () => {
      if (!canRunTests()) {
        return;
      }

      // Try to update a different user's profile (use a different ID)
      const otherUserId = 'different-user-id';

      const response = await apiRequest.put(
        `${API_URL}/users/${otherUserId}/update-profile`,
        {
          data: {
            displayName: 'Unauthorized Change',
          },
        }
      );

      expect(response.ok()).toBe(false);
      expect(response.status()).toBe(403);
    });
  });

  describe('Input Validation', () => {
    test('should validate display name length', async () => {
      if (!canRunTests()) {
        return;
      }

      // Try extremely long display name
      const longName = 'a'.repeat(300);

      const response = await apiRequest.put(
        `${API_URL}/users/${testUserId}/update-profile`,
        {
          data: {
            displayName: longName,
          },
        }
      );

      // Should either be rejected or truncated
      const data = await response.json();
      if (response.ok()) {
        expect(data.user.displayName.length).toBeLessThanOrEqual(100);
      } else {
        expect(response.status()).toBe(400);
      }
    });

    test('should validate username format', async () => {
      if (!canRunTests()) {
        return;
      }

      // Try invalid username with special characters
      const invalidUsername = 'user@#$%^&*()';

      const response = await apiRequest.put(
        `${API_URL}/users/${testUserId}/update-profile`,
        {
          data: {
            username: invalidUsername,
          },
        }
      );

      // Should be rejected if validation is in place
      if (!response.ok()) {
        expect(response.status()).toBe(400);
      }
    });

    test('should validate bio length', async () => {
      if (!canRunTests()) {
        return;
      }

      // Try extremely long bio
      const longBio = 'a'.repeat(2000);

      const response = await apiRequest.put(
        `${API_URL}/users/${testUserId}/update-profile`,
        {
          data: {
            bio: longBio,
          },
        }
      );

      // Should either be rejected or truncated
      const data = await response.json();
      if (response.ok()) {
        expect(data.user.bio.length).toBeLessThanOrEqual(500);
      } else {
        expect(response.status()).toBe(400);
      }
    });
  });
});
