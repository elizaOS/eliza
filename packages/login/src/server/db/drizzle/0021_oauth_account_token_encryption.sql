-- Encrypt OAuth provider tokens at rest.
--
-- This migration renames the existing plaintext token columns to their encrypted
-- storage names and adds AES-256-GCM metadata columns matching KeyStore output.
-- Existing values remain temporarily readable plaintext in *_encrypted until the
-- companion migration script below encrypts them in place:
--   STEWARD_MASTER_PASSWORD=... bun run scripts/encrypt-oauth-account-tokens.ts
--
-- Down migration (manual): run a decrypt/export first, then drop the metadata
-- columns and rename access_token_encrypted/refresh_token_encrypted back to
-- access_token/refresh_token. Reversing without the master password is not safe.

ALTER TABLE "accounts" RENAME COLUMN "access_token" TO "access_token_encrypted";
--> statement-breakpoint
ALTER TABLE "accounts" RENAME COLUMN "refresh_token" TO "refresh_token_encrypted";
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "access_token_iv" text;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "access_token_tag" text;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "access_token_salt" text;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "refresh_token_iv" text;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "refresh_token_tag" text;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "refresh_token_salt" text;
