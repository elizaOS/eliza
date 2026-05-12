#!/usr/bin/env python3
"""
Demonstrate the relationship between JSON files and SQLite database
"""

import sys
import os
import json
import sqlite3

sys.path.insert(0, os.path.dirname(__file__))

from database_utils import GoogleCloudDatabase


def print_section(title):
    print(f"\n{'=' * 70}")
    print(f"  {title}")
    print('=' * 70)


def main():
    print_section("JSON Files and SQLite Database Relationship Demo")
    
    db = GoogleCloudDatabase()
    
    # ==================== Step 1: View JSON Metadata ====================
    print_section("Step 1: View JSON Metadata")

    # Read table metadata
    tables_file = os.path.join(db.data_dir, "bigquery_tables.json")
    with open(tables_file, 'r') as f:
        tables = json.load(f)
    
    # Select a table for demonstration
    table_key = "project-1:sales_dataset.transactions"
    if table_key in tables:
        table_info = tables[table_key]
        print(f"\n📋 JSON Metadata ({table_key}):")
        print(f"  - Table ID: {table_info['tableId']}")
        print(f"  - Project ID: {table_info['projectId']}")
        print(f"  - Dataset ID: {table_info['datasetId']}")
        print(f"  - Recorded Row Count: {table_info['numRows']}")
        print(f"  - Last Modified: {table_info['modified']}")
        print(f"\n  Schema (first 3 columns):")
        for field in table_info['schema'][:3]:
            print(f"    - {field['name']}: {field['type']} ({field['mode']})")
    
    # ==================== Step 2: View SQLite Actual Data ====================
    print_section("Step 2: View SQLite Actual Data")

    # Connect to SQLite database
    sqlite_db = os.path.join(db.data_dir, "bigquery_data.db")
    conn = sqlite3.connect(sqlite_db)
    cursor = conn.cursor()
    
    # View table structure
    table_name = "project-1_sales_dataset_transactions"
    print(f"\n🗄️  SQLite Table Structure ({table_name}):")
    cursor.execute(f'PRAGMA table_info("{table_name}")')
    columns = cursor.fetchall()
    for col in columns:
        print(f"  - {col[1]}: {col[2]} {'NOT NULL' if col[3] else ''}")
    
    # View actual row count
    cursor.execute(f'SELECT COUNT(*) FROM "{table_name}"')
    actual_row_count = cursor.fetchone()[0]
    print(f"\n📊 SQLite Actual Row Count: {actual_row_count}")

    # View some data rows
    print(f"\n📝 SQLite Data Sample (first 3 rows):")
    cursor.execute(f'SELECT * FROM "{table_name}" LIMIT 3')
    rows = cursor.fetchall()
    for i, row in enumerate(rows, 1):
        print(f"  Row {i}: transaction_id={row[0]}, amount={row[2]}")
    
    conn.close()
    
    # ==================== Step 3: Demo Relationship - Insert Data ====================
    print_section("Step 3: Demo Relationship - Insert Data")

    print("\n🔄 Inserting new data...")
    new_row = [{
        "transaction_id": "txn_demo_relation",
        "customer_id": "cust_demo",
        "amount": 999.99,
        "currency": "USD",
        "timestamp": "2024-02-01T15:00:00Z"
    }]
    
    # Record the state before insertion
    print(f"\nBefore insertion:")
    print(f"  - JSON metadata shows row count: {table_info['numRows']}")

    # Insert data
    success = db.insert_table_rows("project-1", "sales_dataset", "transactions", new_row)
    print(f"  - Insert operation: {'✅ Success' if success else '❌ Failed'}")

    # Check the state after insertion
    print(f"\nAfter insertion:")

    # 1. JSON metadata is automatically updated
    with open(tables_file, 'r') as f:
        tables_updated = json.load(f)
    table_info_updated = tables_updated[table_key]
    print(f"  - JSON metadata updated row count: {table_info_updated['numRows']}")
    print(f"  - JSON modification time updated: {table_info_updated['modified']}")

    # 2. SQLite data is also added
    conn = sqlite3.connect(sqlite_db)
    cursor = conn.cursor()
    cursor.execute(f'SELECT COUNT(*) FROM "{table_name}"')
    new_row_count = cursor.fetchone()[0]
    print(f"  - SQLite actual row count: {new_row_count}")

    # Verify the new data actually exists
    cursor.execute(f'SELECT * FROM "{table_name}" WHERE transaction_id = "txn_demo_relation"')
    new_data = cursor.fetchone()
    if new_data:
        print(f"  - ✅ Found new data in SQLite: {new_data[0]}, amount={new_data[2]}")
    
    conn.close()
    
    # ==================== Step 4: Demo Relationship - Query Cache ====================
    print_section("Step 4: Demo Relationship - Query Cache")

    # Execute query
    query = f'SELECT * FROM `project-1.sales_dataset.transactions` WHERE transaction_id = "txn_demo_relation"'
    print(f"\n🔍 Executing query: {query}")

    result = db.run_bigquery_query(query)
    print(f"  - Query status: {result['status']}")
    print(f"  - Rows returned: {result['totalRows']}")
    print(f"  - Is cached: {result.get('cached', False)}")

    # View cache file
    cache_file = os.path.join(db.data_dir, "query_results.json")
    with open(cache_file, 'r') as f:
        cache = json.load(f)
    print(f"\n💾 Query results cached to query_results.json")
    print(f"  - Number of cached queries: {len(cache)}")

    # Execute the same query again
    print(f"\n🔍 Executing the same query again...")
    result2 = db.run_bigquery_query(query)
    print(f"  - Using cache: {result2.get('cached', False)}")
    
    # ==================== Step 5: Demo Relationship - Delete Data ====================
    print_section("Step 5: Demo Relationship - Delete Data")

    print(f"\n🗑️  Deleting test data...")
    deleted = db.delete_table_rows("project-1", "sales_dataset", "transactions",
                                   "transaction_id = 'txn_demo_relation'")
    print(f"  - Deleted {deleted} rows")

    # Check the state after deletion
    print(f"\nAfter deletion:")

    # 1. JSON metadata is updated again
    with open(tables_file, 'r') as f:
        tables_final = json.load(f)
    table_info_final = tables_final[table_key]
    print(f"  - JSON metadata row count restored: {table_info_final['numRows']}")

    # 2. SQLite data is deleted
    conn = sqlite3.connect(sqlite_db)
    cursor = conn.cursor()
    cursor.execute(f'SELECT COUNT(*) FROM "{table_name}"')
    final_row_count = cursor.fetchone()[0]
    print(f"  - SQLite row count restored: {final_row_count}")

    # 3. Cache is cleared
    with open(cache_file, 'r') as f:
        cache_final = json.load(f)
    print(f"  - Query cache cleared: {len(cache_final)} cached items")
    
    conn.close()
    
    # ==================== Summary ====================
    print_section("Summary: JSON and SQLite Relationship")

    print("""
✅ Relationship Summary:

1. **Schema Definition (JSON → SQLite)**
   - JSON files define the table schema (column names, types)
   - SQLite creates table structure based on schema
   - Relationship: JSON is the "blueprint", SQLite is the "building"

2. **Data Storage (SQLite + JSON)**
   - SQLite stores actual row data
   - JSON records statistics (row count, size, modification time)
   - Relationship: SQLite is the "warehouse", JSON is the "inventory"

3. **Data Operations (Bidirectional Sync)**
   - INSERT/UPDATE/DELETE operate on SQLite
   - Automatically updates JSON metadata
   - Relationship: Auto-sync after operations, maintains consistency

4. **Query Cache (JSON)**
   - Query results cached in JSON file
   - Cache cleared when data is modified
   - Relationship: Cache improves performance, invalidated on modification

5. **File Responsibilities**
   ```
   bigquery_datasets.json    → Dataset configuration
   bigquery_tables.json      → Table schema + statistics
   bigquery_data.db          → Actual table data
   query_results.json        → Query result cache
   storage_*.json            → Cloud Storage metadata
   compute_*.json            → Compute Engine metadata
   iam_*.json                → IAM metadata
   ```

🎯 Core Design Philosophy:
  - JSON → Metadata, configuration, cache (human-readable)
  - SQLite → Data, queries (machine-optimized)
  - Auto-sync → Maintains consistency
    """)
    
    print("\n" + "=" * 70)
    print("Demo completed!")
    print("=" * 70)


if __name__ == "__main__":
    main()

