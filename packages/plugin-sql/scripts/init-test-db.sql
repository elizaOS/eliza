-- Enable pgvector extension (must be done by superuser before non-admin user is created)
-- This is required because plugin-sql's extension-manager tries to create it but
-- non-superusers cannot create extensions - they get a permission denied error
CREATE EXTENSION IF NOT EXISTS "vector";

-- Create non-admin user for RLS testing (superusers bypass RLS!)
-- Password must match what RLS tests expect (they use test123)
CREATE USER eliza_test WITH PASSWORD 'test123';

-- Grant necessary permissions (but NOT superuser)
-- GRANT CREATE allows creating schemas (needed for migrations schema)
GRANT ALL ON DATABASE eliza_test TO eliza_test;
GRANT CREATE ON DATABASE eliza_test TO eliza_test;
GRANT ALL ON SCHEMA public TO eliza_test;

-- Allow creating tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO eliza_test;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO eliza_test;

-- Note: eliza_test is NOT a superuser, so RLS policies will apply
