import type { UUID } from '@elizaos/core';

export const SERVER_URL = 'http://localhost:7998';
export const SUPABASE_URL = process.env.SUPABASE_URL || '';
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
export const TEST_EMAIL = 'testuser123@example.com';
export const TEST_PASSWORD = 'mock_password_123!@#';
export const TEST_EMAIL_2 = 'testuser234@example.com';
export const TEST_PASSWORD_2 = 'mock_password_234!@#';

export const zeroUuid = '00000000-0000-0000-0000-000000000000' as UUID;
