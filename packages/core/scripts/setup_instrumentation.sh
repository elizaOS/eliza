#!/bin/bash

# Set variables - these are used for the connection string
DB_HOST=${DB_HOST:-localhost}
DB_PORT=${DB_PORT:-5432}
DB_USER=${DB_USER:-postgres}
DB_PASSWORD=${DB_PASSWORD:-postgres}
DB_NAME=${DB_NAME:-eliza_tracing}
CONTAINER_NAME=${CONTAINER_NAME:-eliza-postgres}

# Show what we're about to do
echo "Setting up instrumentation tables in PostgreSQL"
echo "Host: $DB_HOST"
echo "Port: $DB_PORT"
echo "User: $DB_USER"
echo "Database: $DB_NAME"
echo "Container: $CONTAINER_NAME"

# Create the dedicated instrumentation database if it doesn't exist
echo "Creating database $DB_NAME if it doesn't exist..."
docker exec -i $CONTAINER_NAME psql -U $DB_USER -c "CREATE DATABASE $DB_NAME WITH ENCODING 'UTF8' TEMPLATE=template0;" || echo "Database may already exist, continuing..."

# Copy the SQL file to the container
SQL_FILE="./scripts/instrumentation/setup_traces_table.sql"
TMP_SQL_FILE="/tmp/setup_traces_table.sql"

echo "Copying SQL script to container..."
docker cp $SQL_FILE $CONTAINER_NAME:$TMP_SQL_FILE

# Run the SQL script to create the table in the instrumentation database
echo "Creating traces table in $DB_NAME database..."
docker exec -i $CONTAINER_NAME psql -U $DB_USER -d $DB_NAME -f $TMP_SQL_FILE

if [ $? -eq 0 ]; then
    echo "✅ Instrumentation tables created successfully!"
    echo
    echo "Add these lines to your .env file (if not already present):"
    echo "----------------------------------------------------------------"
    echo "POSTGRES_URL_INSTRUMENTATION=postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"
    echo "INSTRUMENTATION_ENABLED=true"
    echo "OTEL_SERVICE_NAME=eliza-agent"
    echo "----------------------------------------------------------------"
else
    echo "❌ Failed to create instrumentation tables!"
    echo "Check that PostgreSQL is running and accessible."
fi

# Clean up the temporary file
docker exec -i $CONTAINER_NAME rm $TMP_SQL_FILE || echo "Could not remove temporary file" 