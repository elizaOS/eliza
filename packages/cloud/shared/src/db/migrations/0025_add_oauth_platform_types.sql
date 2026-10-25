-- Add new platform types for generic OAuth support
-- These enable Linear, Notion, and other OAuth providers

ALTER TYPE "platform_credential_type" ADD VALUE IF NOT EXISTS 'linear';
ALTER TYPE "platform_credential_type" ADD VALUE IF NOT EXISTS 'notion';
ALTER TYPE "platform_credential_type" ADD VALUE IF NOT EXISTS 'hubspot';
ALTER TYPE "platform_credential_type" ADD VALUE IF NOT EXISTS 'salesforce';
ALTER TYPE "platform_credential_type" ADD VALUE IF NOT EXISTS 'jira';
ALTER TYPE "platform_credential_type" ADD VALUE IF NOT EXISTS 'asana';
ALTER TYPE "platform_credential_type" ADD VALUE IF NOT EXISTS 'airtable';
ALTER TYPE "platform_credential_type" ADD VALUE IF NOT EXISTS 'dropbox';
ALTER TYPE "platform_credential_type" ADD VALUE IF NOT EXISTS 'spotify';
ALTER TYPE "platform_credential_type" ADD VALUE IF NOT EXISTS 'zoom';
