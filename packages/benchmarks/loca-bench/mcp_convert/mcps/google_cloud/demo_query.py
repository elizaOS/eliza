#!/usr/bin/env python3
"""
Demo script showing BigQuery query functionality

Demonstrates how to query local BigQuery data using SQL-like syntax
"""

import sys
import os
import asyncio
import json

# Add project root to path
current_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, current_dir)

from database_utils import GoogleCloudDatabase
from server import GoogleCloudMCPServer


async def demo_queries():
    """Demonstrate various query capabilities"""
    
    print("=" * 70)
    print("Google Cloud MCP Server - BigQuery Query Demo")
    print("=" * 70)
    print()
    
    # Initialize server
    server = GoogleCloudMCPServer()
    db = server.db
    
    # Show available datasets and tables
    print("📊 Available Data:")
    print("-" * 70)
    datasets = db.list_bigquery_datasets()
    for ds in datasets:
        print(f"\n  Dataset: {ds['projectId']}.{ds['datasetId']} ({ds.get('location', 'Unknown')})")
        tables = db.list_bigquery_tables(ds['projectId'], ds['datasetId'])
        for table in tables:
            print(f"    └─ Table: {table['tableId']} ({table.get('numRows', 0):,} rows)")
    
    print("\n" + "=" * 70)
    print("🔍 Query Examples:")
    print("=" * 70)
    
    # Example queries
    queries = [
        {
            "name": "Query 1: Select from user events table",
            "sql": "SELECT * FROM `project-1.analytics_dataset.user_events` LIMIT 5"
        },
        {
            "name": "Query 2: Select from transactions table",
            "sql": "SELECT * FROM `project-1.sales_dataset.transactions` LIMIT 3"
        },
        {
            "name": "Query 3: Query ML training data",
            "sql": "SELECT * FROM `project-2.ml_dataset.training_data` LIMIT 2"
        },
        {
            "name": "Query 4: Cached query (run twice to see caching)",
            "sql": "SELECT * FROM `project-1.analytics_dataset.user_sessions` LIMIT 4"
        }
    ]
    
    for i, query_info in enumerate(queries, 1):
        print(f"\n{query_info['name']}")
        print(f"SQL: {query_info['sql']}")
        print("-" * 70)
        
        # Execute query through server
        result = await server.bigquery_run_query({"query": query_info['sql']})
        
        # Display result
        result_data = result[0].text if hasattr(result[0], 'text') else str(result)
        
        # Parse JSON if it's in the text
        try:
            if hasattr(result[0], 'text'):
                # Try to extract JSON from text
                import re
                json_match = re.search(r'\{.*\}', result[0].text, re.DOTALL)
                if json_match:
                    result_obj = json.loads(json_match.group())
                else:
                    result_obj = {"text": result[0].text}
            else:
                result_obj = result
            
            print(f"  Status: {result_obj.get('status', 'N/A')}")
            print(f"  Query ID: {result_obj.get('queryId', 'N/A')}")
            print(f"  Total Rows: {result_obj.get('totalRows', 0)}")
            print(f"  Execution Time: {result_obj.get('duration_ms', 0)} ms")
            print(f"  Cached: {result_obj.get('cached', False)}")
            
            if 'results' in result_obj and result_obj['results']:
                print(f"\n  Sample Results:")
                for idx, row in enumerate(result_obj['results'][:3], 1):
                    print(f"    Row {idx}: {json.dumps(row, indent=6)}")
                if len(result_obj['results']) > 3:
                    print(f"    ... and {len(result_obj['results']) - 3} more rows")
        except:
            print(f"  Result: {result_data}")
        
        if i == 4:
            # Run the same query again to demonstrate caching
            print(f"\n  Running same query again to demonstrate caching...")
            result2 = await server.bigquery_run_query({"query": query_info['sql']})
            print(f"  ✓ Second execution should be cached and faster!")
    
    print("\n" + "=" * 70)
    print("✅ Query Features:")
    print("=" * 70)
    print("""
  1. ✓ Parse SQL queries with FROM clause
  2. ✓ Extract project.dataset.table references  
  3. ✓ Look up table schema from metadata
  4. ✓ Generate sample data based on schema types
  5. ✓ Support LIMIT clause
  6. ✓ Cache query results for performance
  7. ✓ Return structured JSON results
  8. ✓ Track execution time
    """)
    
    print("\n" + "=" * 70)
    print("🚀 Next Steps for Enhancement:")
    print("=" * 70)
    print("""
  • Add WHERE clause filtering support
  • Implement GROUP BY and aggregations (COUNT, SUM, AVG)
  • Support JOIN operations across tables
  • Add ORDER BY sorting
  • Store actual row data (not just schema-based samples)
  • Support INSERT/UPDATE/DELETE operations
    """)


if __name__ == "__main__":
    asyncio.run(demo_queries())

