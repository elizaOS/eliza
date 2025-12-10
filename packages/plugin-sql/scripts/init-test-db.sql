-- Create non-admin user for RLS testing (superusers bypass RLS!)
CREATE USER eliza_test WITH PASSWORD 'eliza_test_password';

-- Grant necessary permissions (but NOT superuser)
GRANT ALL ON DATABASE eliza_test TO eliza_test;
GRANT ALL ON SCHEMA public TO eliza_test;

-- Allow creating tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO eliza_test;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO eliza_test;

-- Note: eliza_test is NOT a superuser, so RLS policies will apply
