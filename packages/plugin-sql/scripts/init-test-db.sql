-- Enable pgvector extension (must be done by superuser before non-admin user is created)
-- This is required because plugin-sql's extension-manager tries to create it but
-- non-superusers cannot create extensions - they get a permission denied error
CREATE EXTENSION IF NOT EXISTS "vector";

-- Clean up RLS functions that may exist from previous test runs
-- This is required because CREATE OR REPLACE FUNCTION requires ownership
-- Without this, tests fail with "must be owner of function current_server_id"
DROP FUNCTION IF EXISTS current_server_id() CASCADE;
DROP FUNCTION IF EXISTS current_entity_id() CASCADE;
DROP FUNCTION IF EXISTS add_server_isolation(text, text) CASCADE;
DROP FUNCTION IF EXISTS apply_rls_to_all_tables() CASCADE;
DROP FUNCTION IF EXISTS apply_entity_rls_to_all_tables() CASCADE;

-- Create non-admin user for RLS testing (superusers bypass RLS!)
-- Password must match what RLS tests expect (they use test123)
CREATE USER eliza_test WITH PASSWORD 'test123';

-- Grant necessary permissions (but NOT superuser)
-- GRANT CREATE allows creating schemas (needed for migrations schema)
GRANT ALL ON DATABASE eliza_test TO eliza_test;
GRANT CREATE ON DATABASE eliza_test TO eliza_test;

-- PostgreSQL 15+ changed default permissions on public schema
-- These grants are required for non-superusers to create objects in public schema
GRANT ALL ON SCHEMA public TO eliza_test;
GRANT USAGE ON SCHEMA public TO eliza_test;
GRANT CREATE ON SCHEMA public TO eliza_test;

-- Set default search_path for the user (required for table creation)
ALTER USER eliza_test SET search_path TO public;

-- Allow creating tables/sequences (applies to objects created by postgres user)
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO eliza_test;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO eliza_test;

-- Note: eliza_test is NOT a superuser, so RLS policies will apply
