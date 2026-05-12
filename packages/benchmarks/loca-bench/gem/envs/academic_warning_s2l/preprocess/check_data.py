from google.cloud import bigquery

PROJECT_ID = "mcp-bench0606"
DATASET = "academic_warning"

client = bigquery.Client(project=PROJECT_ID)

# Query the first 10 rows
query = f"SELECT * FROM `{PROJECT_ID}.{DATASET}.scores_2501` LIMIT 10"
df = client.query(query).to_dataframe()
print(df)
