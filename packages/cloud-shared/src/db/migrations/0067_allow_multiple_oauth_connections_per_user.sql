-- Allow multiple OAuth connections per (user_id, platform) for the same user.
-- Uniqueness is still enforced by platform_credentials_platform_user_idx on
-- (organization_id, platform, platform_user_id) so a single Google account
-- cannot be linked twice, but a user can link multiple distinct Google
-- accounts (e.g. personal + work gmail) on the same platform.

DROP INDEX IF EXISTS "platform_credentials_user_platform_idx";
