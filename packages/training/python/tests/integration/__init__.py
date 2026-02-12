# Training Pipeline Integration Tests
#
# This package contains integration tests that require running infrastructure.
#
# Test Tiers:
# - test_json_mode_integration.py: Tests JSON-only trajectory processing (no DB)
# - test_db_integration.py: Tests database trajectory processing (requires PostgreSQL)
#
# Setup:
#   docker compose -f docker-compose.test.yml up -d
#   DATABASE_URL=postgresql://babylon_test:test_password@localhost:5434/babylon_test pytest python/tests/integration/

