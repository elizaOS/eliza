#!/bin/bash
# Creates the 'steward' database used by the Steward auth service.
# Mounted as /docker-entrypoint-initdb.d/20-steward.sh in the postgres container.
# The numeric prefix (20) ensures this runs after any 10-* init scripts.
set -e

echo "[init] Creating Steward auth database..."

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
  SELECT 'CREATE DATABASE steward'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'steward')\gexec
  GRANT ALL PRIVILEGES ON DATABASE steward TO $POSTGRES_USER;
EOSQL

echo "[init] Steward database ready."
