# Data Engineering Templates & Code Examples

Production-ready templates for data pipelines, ETL workflows, SQL queries, and infrastructure code.

## Table of Contents

1. [Airflow DAG Templates](#airflow-dag-templates)
2. [Spark Job Templates](#spark-job-templates)
3. [dbt Model Templates](#dbt-model-templates)
4. [SQL Query Patterns](#sql-query-patterns)
5. [Python Pipeline Templates](#python-pipeline-templates)
6. [Docker & Deployment](#docker--deployment)
7. [Configuration Files](#configuration-files)
8. [Testing Templates](#testing-templates)

---

## Airflow DAG Templates

### Complete ETL DAG

```python
from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.operators.bash import BashOperator
from airflow.providers.amazon.aws.operators.s3 import S3CreateObjectOperator
from airflow.providers.snowflake.operators.snowflake import SnowflakeOperator
from airflow.utils.task_group import TaskGroup
from datetime import datetime, timedelta
import logging

# Default arguments
default_args = {
    'owner': 'data-team',
    'depends_on_past': False,
    'email': ['data-alerts@company.com'],
    'email_on_failure': True,
    'email_on_retry': False,
    'retries': 3,
    'retry_delay': timedelta(minutes=5),
    'retry_exponential_backoff': True,
    'max_retry_delay': timedelta(hours=1)
}

# DAG definition
dag = DAG(
    dag_id='sales_etl_pipeline',
    default_args=default_args,
    description='Daily sales data ETL pipeline',
    schedule_interval='0 2 * * *',  # 2 AM daily
    start_date=datetime(2025, 1, 1),
    catchup=False,
    tags=['sales', 'etl', 'production']
)

def extract_from_source(**context):
    """
    Extract data from source system
    """
    from sqlalchemy import create_engine
    import pandas as pd

    execution_date = context['ds']
    logging.info(f"Extracting data for {execution_date}")

    # Database connection
    engine = create_engine(context['var']['value']['source_db_url'])

    # Query with date filter
    query = f"""
    SELECT *
    FROM sales_transactions
    WHERE DATE(transaction_date) = '{execution_date}'
    """

    df = pd.read_sql(query, engine)
    logging.info(f"Extracted {len(df)} rows")

    # Save to staging
    staging_path = f"s3://bucket/staging/sales/{execution_date}.parquet"
    df.to_parquet(staging_path, index=False)

    # Pass metadata to XCom
    return {
        'row_count': len(df),
        'staging_path': staging_path
    }

def transform_data(**context):
    """
    Transform and clean data
    """
    import pandas as pd

    # Get staging path from XCom
    task_instance = context['task_instance']
    extract_result = task_instance.xcom_pull(task_ids='extract_task')
    staging_path = extract_result['staging_path']

    logging.info(f"Transforming data from {staging_path}")

    # Load data
    df = pd.read_parquet(staging_path)

    # Data cleaning
    df = df.dropna(subset=['transaction_id', 'customer_id'])
    df['transaction_date'] = pd.to_datetime(df['transaction_date'])
    df['amount'] = df['amount'].astype(float)

    # Business logic transformations
    df['revenue'] = df['amount'] - df['discount']
    df['profit'] = df['revenue'] - df['cost']
    df['profit_margin'] = (df['profit'] / df['revenue'] * 100).round(2)

    # Enrichment
    df['day_of_week'] = df['transaction_date'].dt.dayofweek
    df['is_weekend'] = df['day_of_week'].isin([5, 6])

    # Data quality checks
    assert df['amount'].min() >= 0, "Negative amounts detected"
    assert df['transaction_id'].is_unique, "Duplicate transaction IDs"

    # Save transformed data
    execution_date = context['ds']
    transformed_path = f"s3://bucket/transformed/sales/{execution_date}.parquet"
    df.to_parquet(transformed_path, index=False)

    return {
        'row_count': len(df),
        'transformed_path': transformed_path
    }

def load_to_warehouse(**context):
    """
    Load data to data warehouse
    """
    from snowflake.connector import connect

    task_instance = context['task_instance']
    transform_result = task_instance.xcom_pull(task_ids='transform_task')
    transformed_path = transform_result['transformed_path']

    logging.info(f"Loading data from {transformed_path}")

    # Snowflake connection
    conn = connect(
        user=context['var']['value']['snowflake_user'],
        password=context['var']['value']['snowflake_password'],
        account=context['var']['value']['snowflake_account'],
        warehouse='COMPUTE_WH',
        database='ANALYTICS',
        schema='SALES'
    )

    # Create stage if not exists
    conn.cursor().execute("""
        CREATE STAGE IF NOT EXISTS sales_stage
        URL = 's3://bucket/transformed/sales/'
        CREDENTIALS = (AWS_KEY_ID = '...' AWS_SECRET_KEY = '...')
        FILE_FORMAT = (TYPE = PARQUET)
    """)

    # Copy into table
    execution_date = context['ds']
    conn.cursor().execute(f"""
        COPY INTO sales_fact
        FROM @sales_stage/{execution_date}.parquet
        FILE_FORMAT = (TYPE = PARQUET)
        MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE
        ON_ERROR = ABORT_STATEMENT
    """)

    conn.close()
    logging.info("Load completed successfully")

def run_quality_checks(**context):
    """
    Run data quality checks on loaded data
    """
    from snowflake.connector import connect

    execution_date = context['ds']
    conn = connect(...)

    # Row count validation
    cursor = conn.cursor()
    cursor.execute(f"""
        SELECT COUNT(*)
        FROM sales_fact
        WHERE DATE(transaction_date) = '{execution_date}'
    """)
    row_count = cursor.fetchone()[0]

    # Get expected count from XCom
    task_instance = context['task_instance']
    extract_result = task_instance.xcom_pull(task_ids='extract_task')
    expected_count = extract_result['row_count']

    # Validate
    assert row_count == expected_count, \
        f"Row count mismatch: expected {expected_count}, got {row_count}"

    # Aggregate validation
    cursor.execute(f"""
        SELECT
            SUM(amount) as total_amount,
            AVG(amount) as avg_amount,
            COUNT(DISTINCT customer_id) as unique_customers
        FROM sales_fact
        WHERE DATE(transaction_date) = '{execution_date}'
    """)
    metrics = cursor.fetchone()

    logging.info(f"Quality checks passed: {metrics}")
    conn.close()

# Task definitions
with dag:
    start = BashOperator(
        task_id='start',
        bash_command='echo "Starting sales ETL pipeline"'
    )

    extract_task = PythonOperator(
        task_id='extract_task',
        python_callable=extract_from_source,
        provide_context=True
    )

    transform_task = PythonOperator(
        task_id='transform_task',
        python_callable=transform_data,
        provide_context=True
    )

    load_task = PythonOperator(
        task_id='load_task',
        python_callable=load_to_warehouse,
        provide_context=True
    )

    quality_check_task = PythonOperator(
        task_id='quality_check_task',
        python_callable=run_quality_checks,
        provide_context=True
    )

    end = BashOperator(
        task_id='end',
        bash_command='echo "Pipeline completed successfully"'
    )

    # Task dependencies
    start >> extract_task >> transform_task >> load_task >> quality_check_task >> end
```

### Incremental Load DAG

```python
from airflow import DAG
from airflow.operators.python import PythonOperator
from datetime import datetime, timedelta

def incremental_etl(**context):
    """
    Incremental data loading with watermark tracking
    """
    import pandas as pd
    from sqlalchemy import create_engine

    # Get last watermark
    watermark_query = """
    SELECT MAX(updated_at) as last_updated
    FROM staging.watermarks
    WHERE table_name = 'sales_transactions'
    """

    engine = create_engine(...)
    last_updated = pd.read_sql(watermark_query, engine)['last_updated'][0]

    # Extract incremental changes
    incremental_query = f"""
    SELECT *
    FROM sales_transactions
    WHERE updated_at > '{last_updated}'
    ORDER BY updated_at
    """

    df = pd.read_sql(incremental_query, engine)

    if len(df) == 0:
        logging.info("No new data to process")
        return

    # Transform
    df = transform_sales_data(df)

    # Upsert to target
    df.to_sql(
        name='sales_fact',
        con=engine,
        schema='analytics',
        if_exists='append',
        index=False,
        method='multi',
        chunksize=10000
    )

    # Update watermark
    new_watermark = df['updated_at'].max()
    engine.execute(f"""
        UPDATE staging.watermarks
        SET last_updated = '{new_watermark}',
            updated_at = CURRENT_TIMESTAMP
        WHERE table_name = 'sales_transactions'
    """)

    logging.info(f"Processed {len(df)} rows, new watermark: {new_watermark}")

dag = DAG(
    dag_id='incremental_sales_etl',
    schedule_interval='*/15 * * * *',  # Every 15 minutes
    start_date=datetime(2025, 1, 1),
    catchup=False
)

task = PythonOperator(
    task_id='incremental_load',
    python_callable=incremental_etl,
    provide_context=True,
    dag=dag
)
```

### Dynamic Task Generation DAG

```python
from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.models import Variable
from datetime import datetime

# Get list of tables to process from Airflow Variables
tables_config = Variable.get("etl_tables", deserialize_json=True)

dag = DAG(
    dag_id='multi_table_etl',
    schedule_interval='0 3 * * *',
    start_date=datetime(2025, 1, 1),
    catchup=False
)

def process_table(table_name, **context):
    """Generic table processing function"""
    logging.info(f"Processing table: {table_name}")

    # Extract
    df = extract_table(table_name)

    # Transform
    df = apply_transformations(df, table_name)

    # Load
    load_to_warehouse(df, table_name)

# Dynamically create tasks for each table
for table_config in tables_config:
    table_name = table_config['name']
    dependencies = table_config.get('depends_on', [])

    task = PythonOperator(
        task_id=f'process_{table_name}',
        python_callable=process_table,
        op_kwargs={'table_name': table_name},
        provide_context=True,
        dag=dag
    )
```

---

## Spark Job Templates

### Batch Processing Job

```python
from pyspark.sql import SparkSession
from pyspark.sql.functions import *
from pyspark.sql.window import Window
import sys

def create_spark_session(app_name):
    """Create Spark session with optimized configuration"""
    return SparkSession.builder \
        .appName(app_name) \
        .config("spark.sql.adaptive.enabled", "true") \
        .config("spark.sql.adaptive.coalescePartitions.enabled", "true") \
        .config("spark.sql.shuffle.partitions", "200") \
        .config("spark.serializer", "org.apache.spark.serializer.KryoSerializer") \
        .config("spark.sql.parquet.compression.codec", "snappy") \
        .getOrCreate()

def transform_sales_data(spark, input_path, output_path, date):
    """
    Process sales data with complex transformations
    """

    # Read data
    df = spark.read.parquet(input_path)

    # Filter by date
    df = df.filter(col("transaction_date") == date)

    # Data cleaning
    df = df.dropna(subset=["transaction_id", "customer_id"]) \
           .dropDuplicates(["transaction_id"])

    # Type casting
    df = df.withColumn("amount", col("amount").cast("double")) \
           .withColumn("quantity", col("quantity").cast("int"))

    # Business logic transformations
    df = df.withColumn("revenue", col("amount") - col("discount")) \
           .withColumn("profit", col("revenue") - col("cost")) \
           .withColumn("profit_margin",
                      round((col("profit") / col("revenue")) * 100, 2))

    # Date features
    df = df.withColumn("year", year("transaction_date")) \
           .withColumn("month", month("transaction_date")) \
           .withColumn("day_of_week", dayofweek("transaction_date")) \
           .withColumn("is_weekend",
                      when(col("day_of_week").isin([1, 7]), True).otherwise(False))

    # Window functions - customer metrics
    customer_window = Window.partitionBy("customer_id").orderBy("transaction_date")

    df = df.withColumn("customer_transaction_number",
                      row_number().over(customer_window)) \
           .withColumn("customer_lifetime_value",
                      sum("revenue").over(customer_window.rowsBetween(Window.unboundedPreceding, 0))) \
           .withColumn("days_since_last_purchase",
                      datediff(col("transaction_date"),
                              lag("transaction_date").over(customer_window)))

    # Aggregations
    product_agg = df.groupBy("product_id") \
        .agg(
            count("*").alias("transaction_count"),
            sum("quantity").alias("total_quantity"),
            sum("revenue").alias("total_revenue"),
            avg("amount").alias("avg_transaction_value")
        )

    # Join back aggregated metrics
    df = df.join(
        product_agg.withColumnRenamed("product_id", "prod_id"),
        col("product_id") == col("prod_id"),
        "left"
    ).drop("prod_id")

    # Data quality checks
    assert df.filter(col("amount") < 0).count() == 0, "Negative amounts detected"
    assert df.filter(col("transaction_id").isNull()).count() == 0, "Null transaction IDs"

    # Write output partitioned by date
    df.write \
        .mode("overwrite") \
        .partitionBy("year", "month") \
        .parquet(output_path)

    # Log metrics
    total_records = df.count()
    total_revenue = df.agg(sum("revenue")).collect()[0][0]

    print(f"Processed {total_records} records")
    print(f"Total revenue: ${total_revenue:,.2f}")

    return total_records, total_revenue

def main():
    """Main execution"""
    if len(sys.argv) < 4:
        print("Usage: spark-submit job.py <input_path> <output_path> <date>")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    date = sys.argv[3]

    spark = create_spark_session("Sales Data Processing")

    try:
        transform_sales_data(spark, input_path, output_path, date)
        print("Job completed successfully")
    except Exception as e:
        print(f"Job failed: {str(e)}")
        sys.exit(1)
    finally:
        spark.stop()

if __name__ == "__main__":
    main()
```

### Streaming Job

```python
from pyspark.sql import SparkSession
from pyspark.sql.functions import *
from pyspark.sql.types import *

def create_streaming_session():
    return SparkSession.builder \
        .appName("Real-Time Event Processing") \
        .config("spark.sql.streaming.checkpointLocation", "s3://bucket/checkpoints/") \
        .getOrCreate()

def process_event_stream(spark):
    """
    Process real-time events from Kafka
    """

    # Define schema
    event_schema = StructType([
        StructField("event_id", StringType(), False),
        StructField("user_id", StringType(), False),
        StructField("event_type", StringType(), False),
        StructField("timestamp", TimestampType(), False),
        StructField("properties", MapType(StringType(), StringType()), True)
    ])

    # Read from Kafka
    events_df = spark.readStream \
        .format("kafka") \
        .option("kafka.bootstrap.servers", "kafka:9092") \
        .option("subscribe", "user_events") \
        .option("startingOffsets", "latest") \
        .load()

    # Parse JSON
    parsed_df = events_df \
        .selectExpr("CAST(key AS STRING)", "CAST(value AS STRING)", "timestamp") \
        .select(
            col("key").alias("partition_key"),
            from_json(col("value"), event_schema).alias("data"),
            col("timestamp").alias("kafka_timestamp")
        ) \
        .select("partition_key", "data.*", "kafka_timestamp")

    # Transformations
    enriched_df = parsed_df \
        .withColumn("processing_timestamp", current_timestamp()) \
        .withColumn("date", to_date("timestamp")) \
        .withColumn("hour", hour("timestamp"))

    # Windowed aggregations
    metrics_df = enriched_df \
        .withWatermark("timestamp", "10 minutes") \
        .groupBy(
            window("timestamp", "1 minute", "30 seconds"),
            "event_type"
        ) \
        .agg(
            count("*").alias("event_count"),
            countDistinct("user_id").alias("unique_users")
        )

    # Write to Parquet (for batch analytics)
    parquet_query = enriched_df.writeStream \
        .format("parquet") \
        .option("path", "s3://bucket/events/") \
        .option("checkpointLocation", "s3://bucket/checkpoints/events/") \
        .partitionBy("date", "hour") \
        .outputMode("append") \
        .trigger(processingTime="1 minute") \
        .start()

    # Write metrics to console (monitoring)
    console_query = metrics_df.writeStream \
        .format("console") \
        .outputMode("update") \
        .trigger(processingTime="30 seconds") \
        .start()

    # Wait for termination
    spark.streams.awaitAnyTermination()

if __name__ == "__main__":
    spark = create_streaming_session()
    process_event_stream(spark)
```

---

## dbt Model Templates

### Staging Model

```sql
-- models/staging/stg_sales_transactions.sql
{{
    config(
        materialized='view',
        tags=['staging', 'sales']
    )
}}

WITH source AS (
    SELECT * FROM {{ source('raw', 'sales_transactions') }}
),

renamed AS (
    SELECT
        -- Primary key
        transaction_id,

        -- Foreign keys
        customer_id,
        product_id,
        store_id,

        -- Timestamps
        transaction_date::timestamp AS transaction_timestamp,
        DATE(transaction_date) AS transaction_date,

        -- Measures
        quantity::int AS quantity,
        unit_price::decimal(10,2) AS unit_price,
        amount::decimal(10,2) AS amount,
        discount::decimal(10,2) AS discount,
        cost::decimal(10,2) AS cost,

        -- Metadata
        _loaded_at
    FROM source
),

validated AS (
    SELECT
        *,
        -- Data quality flags
        CASE
            WHEN amount < 0 THEN 'negative_amount'
            WHEN quantity <= 0 THEN 'invalid_quantity'
            WHEN unit_price <= 0 THEN 'invalid_price'
            ELSE NULL
        END AS quality_flag
    FROM renamed
)

SELECT * FROM validated
WHERE quality_flag IS NULL  -- Filter out bad data

-- dbt will track this lineage automatically
```

### Intermediate Model

```sql
-- models/intermediate/int_sales_enriched.sql
{{
    config(
        materialized='ephemeral',
        tags=['intermediate', 'sales']
    )
}}

WITH transactions AS (
    SELECT * FROM {{ ref('stg_sales_transactions') }}
),

customers AS (
    SELECT * FROM {{ ref('stg_customers') }}
),

products AS (
    SELECT * FROM {{ ref('stg_products') }}
),

enriched AS (
    SELECT
        -- Transaction info
        t.transaction_id,
        t.transaction_date,
        t.transaction_timestamp,

        -- Customer info
        c.customer_id,
        c.customer_name,
        c.customer_segment,
        c.customer_lifetime_value,

        -- Product info
        p.product_id,
        p.product_name,
        p.category,
        p.subcategory,
        p.brand,

        -- Measures
        t.quantity,
        t.unit_price,
        t.amount,
        t.discount,
        t.cost,

        -- Calculated metrics
        t.amount - t.discount AS revenue,
        (t.amount - t.discount) - t.cost AS profit,
        ROUND(((t.amount - t.discount) - t.cost) / (t.amount - t.discount) * 100, 2) AS profit_margin_pct

    FROM transactions t
    LEFT JOIN customers c ON t.customer_id = c.customer_id
    LEFT JOIN products p ON t.product_id = p.product_id
)

SELECT * FROM enriched
```

### Fact Table Model

```sql
-- models/marts/fct_sales.sql
{{
    config(
        materialized='incremental',
        unique_key='transaction_id',
        partition_by={
            'field': 'transaction_date',
            'data_type': 'date',
            'granularity': 'day'
        },
        cluster_by=['customer_id', 'product_id'],
        tags=['marts', 'sales', 'fact']
    )
}}

WITH enriched_sales AS (
    SELECT * FROM {{ ref('int_sales_enriched') }}

    {% if is_incremental() %}
        -- Incremental load: only process new data
        WHERE transaction_timestamp > (SELECT MAX(transaction_timestamp) FROM {{ this }})
    {% endif %}
),

with_metrics AS (
    SELECT
        *,
        -- Window functions for customer metrics
        ROW_NUMBER() OVER (
            PARTITION BY customer_id
            ORDER BY transaction_timestamp
        ) AS customer_transaction_sequence,

        LAG(transaction_date) OVER (
            PARTITION BY customer_id
            ORDER BY transaction_timestamp
        ) AS previous_transaction_date,

        -- Days since last purchase
        DATEDIFF('day',
            LAG(transaction_date) OVER (
                PARTITION BY customer_id
                ORDER BY transaction_timestamp
            ),
            transaction_date
        ) AS days_since_last_purchase

    FROM enriched_sales
)

SELECT * FROM with_metrics
```

### Dimension Model with SCD Type 2

```sql
-- models/marts/dim_product.sql
{{
    config(
        materialized='table',
        tags=['marts', 'dimension', 'scd2']
    )
}}

WITH source AS (
    SELECT * FROM {{ ref('stg_products') }}
),

scd_logic AS (
    SELECT
        -- Natural key
        product_id,

        -- Attributes
        product_name,
        category,
        subcategory,
        brand,
        unit_cost,
        is_active,

        -- SCD Type 2 columns
        _loaded_at AS effective_date,
        COALESCE(
            LEAD(_loaded_at) OVER (PARTITION BY product_id ORDER BY _loaded_at),
            '9999-12-31'::date
        ) AS expiry_date,
        CASE
            WHEN LEAD(_loaded_at) OVER (PARTITION BY product_id ORDER BY _loaded_at) IS NULL
            THEN TRUE
            ELSE FALSE
        END AS is_current

    FROM source
)

SELECT
    -- Surrogate key
    {{ dbt_utils.generate_surrogate_key(['product_id', 'effective_date']) }} AS product_key,
    *
FROM scd_logic
```

---

## SQL Query Patterns

### Incremental Merge (Upsert)

```sql
-- Snowflake MERGE syntax
MERGE INTO target_table AS target
USING (
    SELECT
        id,
        name,
        value,
        updated_at
    FROM staging_table
    WHERE updated_at > (SELECT MAX(updated_at) FROM target_table)
) AS source
ON target.id = source.id

-- Update existing records
WHEN MATCHED AND source.updated_at > target.updated_at THEN
    UPDATE SET
        target.name = source.name,
        target.value = source.value,
        target.updated_at = source.updated_at

-- Insert new records
WHEN NOT MATCHED THEN
    INSERT (id, name, value, updated_at)
    VALUES (source.id, source.name, source.value, source.updated_at);
```

### Slowly Changing Dimension Type 2

```sql
-- Expire old records
UPDATE dim_customer
SET
    is_current = FALSE,
    expiry_date = CURRENT_TIMESTAMP
WHERE customer_id IN (
    SELECT customer_id
    FROM staging_customer_updates
)
AND is_current = TRUE;

-- Insert new versions
INSERT INTO dim_customer (
    customer_id,
    first_name,
    last_name,
    email,
    segment,
    effective_date,
    expiry_date,
    is_current
)
SELECT
    customer_id,
    first_name,
    last_name,
    email,
    segment,
    CURRENT_TIMESTAMP AS effective_date,
    '9999-12-31'::date AS expiry_date,
    TRUE AS is_current
FROM staging_customer_updates;
```

### Deduplication with Row Number

```sql
-- Remove duplicates, keeping latest record
WITH ranked AS (
    SELECT
        *,
        ROW_NUMBER() OVER (
            PARTITION BY transaction_id
            ORDER BY updated_at DESC, loaded_at DESC
        ) AS rn
    FROM raw_transactions
)
SELECT *
FROM ranked
WHERE rn = 1;
```

### Date Spine for Gap Filling

```sql
-- Generate date series
WITH date_spine AS (
    SELECT
        DATEADD(day, seq4(), '2025-01-01'::date) AS date
    FROM TABLE(GENERATOR(ROWCOUNT => 365))
),

sales_with_gaps AS (
    SELECT
        DATE(transaction_date) AS date,
        SUM(amount) AS total_sales
    FROM sales_transactions
    GROUP BY 1
)

-- Fill gaps with 0
SELECT
    ds.date,
    COALESCE(s.total_sales, 0) AS total_sales
FROM date_spine ds
LEFT JOIN sales_with_gaps s ON ds.date = s.date
ORDER BY ds.date;
```

---

## Python Pipeline Templates

### Data Quality Validation Class

```python
from typing import List, Dict, Any
import pandas as pd
import logging

class DataQualityValidator:
    """
    Comprehensive data quality validation framework
    """

    def __init__(self, df: pd.DataFrame):
        self.df = df
        self.checks = []

    def check_completeness(self, columns: List[str], threshold: float = 0.95):
        """Check for null values in required columns"""
        for col in columns:
            non_null_pct = self.df[col].notna().mean()
            self.checks.append({
                'dimension': 'completeness',
                'check': f'{col}_not_null',
                'passed': non_null_pct >= threshold,
                'value': non_null_pct,
                'threshold': threshold
            })
        return self

    def check_uniqueness(self, columns: List[str]):
        """Check for duplicate values"""
        for col in columns:
            is_unique = self.df[col].is_unique
            duplicate_count = self.df[col].duplicated().sum()
            self.checks.append({
                'dimension': 'uniqueness',
                'check': f'{col}_unique',
                'passed': is_unique,
                'value': len(self.df) - duplicate_count,
                'duplicates': duplicate_count
            })
        return self

    def check_range(self, column: str, min_val: float = None, max_val: float = None):
        """Check numeric ranges"""
        if min_val is not None:
            min_check = (self.df[column] >= min_val).all()
            self.checks.append({
                'dimension': 'accuracy',
                'check': f'{column}_min',
                'passed': min_check,
                'value': self.df[column].min()
            })

        if max_val is not None:
            max_check = (self.df[column] <= max_val).all()
            self.checks.append({
                'dimension': 'accuracy',
                'check': f'{column}_max',
                'passed': max_check,
                'value': self.df[column].max()
            })
        return self

    def check_format(self, column: str, regex: str):
        """Check string format with regex"""
        valid_format = self.df[column].str.match(regex)
        valid_pct = valid_format.mean()
        self.checks.append({
            'dimension': 'accuracy',
            'check': f'{column}_format',
            'passed': valid_pct >= 0.99,
            'value': valid_pct
        })
        return self

    def check_referential_integrity(self, column: str, reference_values: set):
        """Check foreign key integrity"""
        valid_refs = self.df[column].isin(reference_values)
        valid_pct = valid_refs.mean()
        self.checks.append({
            'dimension': 'consistency',
            'check': f'{column}_referential_integrity',
            'passed': valid_pct >= 0.99,
            'value': valid_pct
        })
        return self

    def get_results(self) -> Dict[str, Any]:
        """Get validation results"""
        failed_checks = [c for c in self.checks if not c['passed']]
        return {
            'total_checks': len(self.checks),
            'passed_checks': len(self.checks) - len(failed_checks),
            'failed_checks': len(failed_checks),
            'all_passed': len(failed_checks) == 0,
            'checks': self.checks,
            'failures': failed_checks
        }

    def raise_on_failure(self):
        """Raise exception if any checks failed"""
        results = self.get_results()
        if not results['all_passed']:
            failures = '\n'.join([
                f"- {c['check']}: {c.get('value')}"
                for c in results['failures']
            ])
            raise ValueError(f"Data quality checks failed:\n{failures}")

# Usage example
validator = DataQualityValidator(df)
results = validator \
    .check_completeness(['transaction_id', 'customer_id']) \
    .check_uniqueness(['transaction_id']) \
    .check_range('amount', min_val=0, max_val=1000000) \
    .check_format('email', r'^[\w\.-]+@[\w\.-]+\.\w+$') \
    .get_results()

if not results['all_passed']:
    logging.error(f"Quality checks failed: {results['failures']}")
```

### Retry Decorator with Exponential Backoff

```python
import time
import logging
from functools import wraps
from typing import Callable, Type, Tuple

def retry_with_backoff(
    max_retries: int = 3,
    initial_delay: float = 1.0,
    backoff_factor: float = 2.0,
    exceptions: Tuple[Type[Exception], ...] = (Exception,)
):
    """
    Retry decorator with exponential backoff
    """
    def decorator(func: Callable):
        @wraps(func)
        def wrapper(*args, **kwargs):
            delay = initial_delay

            for attempt in range(max_retries + 1):
                try:
                    return func(*args, **kwargs)
                except exceptions as e:
                    if attempt == max_retries:
                        logging.error(f"Max retries ({max_retries}) exceeded")
                        raise

                    logging.warning(
                        f"Attempt {attempt + 1} failed: {str(e)}. "
                        f"Retrying in {delay}s..."
                    )
                    time.sleep(delay)
                    delay *= backoff_factor

        return wrapper
    return decorator

# Usage
@retry_with_backoff(max_retries=3, initial_delay=2, backoff_factor=2)
def extract_from_api(url):
    response = requests.get(url)
    response.raise_for_status()
    return response.json()
```

---

## Docker & Deployment

### Dockerfile for Data Pipeline

```dockerfile
FROM python:3.10-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY src/ ./src/
COPY scripts/ ./scripts/

# Set environment variables
ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1

# Run pipeline
CMD ["python", "scripts/run_pipeline.py"]
```

### Docker Compose for Local Development

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:14
    environment:
      POSTGRES_USER: datauser
      POSTGRES_PASSWORD: datapass
      POSTGRES_DB: analytics
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  airflow-webserver:
    image: apache/airflow:2.7.0
    depends_on:
      - postgres
    environment:
      AIRFLOW__CORE__SQL_ALCHEMY_CONN: postgresql+psycopg2://datauser:datapass@postgres/analytics
      AIRFLOW__CORE__EXECUTOR: LocalExecutor
    volumes:
      - ./dags:/opt/airflow/dags
      - ./logs:/opt/airflow/logs
    ports:
      - "8080:8080"
    command: webserver

  spark-master:
    image: bitnami/spark:3.4
    environment:
      - SPARK_MODE=master
    ports:
      - "8081:8080"
      - "7077:7077"

  spark-worker:
    image: bitnami/spark:3.4
    depends_on:
      - spark-master
    environment:
      - SPARK_MODE=worker
      - SPARK_MASTER_URL=spark://spark-master:7077

volumes:
  postgres_data:
```

---

## Configuration Files

### dbt project.yml

```yaml
name: 'analytics'
version: '1.0.0'
config-version: 2

profile: 'analytics'

model-paths: ["models"]
analysis-paths: ["analyses"]
test-paths: ["tests"]
seed-paths: ["seeds"]
macro-paths: ["macros"]
snapshot-paths: ["snapshots"]

target-path: "target"
clean-targets:
  - "target"
  - "dbt_packages"

models:
  analytics:
    staging:
      +materialized: view
      +tags: ['staging']

    intermediate:
      +materialized: ephemeral
      +tags: ['intermediate']

    marts:
      +materialized: table
      +tags: ['marts']

      sales:
        +schema: sales
        +tags: ['sales']

      customers:
        +schema: customers
        +tags: ['customers']

seeds:
  +quote_columns: false

snapshots:
  +target_schema: snapshots
```

### Spark Configuration

```conf
# spark-defaults.conf

# Memory settings
spark.driver.memory=4g
spark.executor.memory=8g
spark.executor.cores=4

# Shuffle settings
spark.sql.shuffle.partitions=200
spark.shuffle.service.enabled=true

# Adaptive query execution
spark.sql.adaptive.enabled=true
spark.sql.adaptive.coalescePartitions.enabled=true

# Dynamic allocation
spark.dynamicAllocation.enabled=true
spark.dynamicAllocation.minExecutors=2
spark.dynamicAllocation.maxExecutors=10

# Serialization
spark.serializer=org.apache.spark.serializer.KryoSerializer

# S3 settings
spark.hadoop.fs.s3a.impl=org.apache.hadoop.fs.s3a.S3AFileSystem
spark.hadoop.fs.s3a.aws.credentials.provider=com.amazonaws.auth.DefaultAWSCredentialsProviderChain
```

---

## Testing Templates

### pytest Fixtures

```python
import pytest
import pandas as pd
from sqlalchemy import create_engine

@pytest.fixture
def sample_sales_data():
    """Sample sales data for testing"""
    return pd.DataFrame({
        'transaction_id': ['T1', 'T2', 'T3'],
        'customer_id': ['C1', 'C2', 'C1'],
        'amount': [100.0, 200.0, 150.0],
        'transaction_date': pd.to_datetime(['2025-01-01', '2025-01-02', '2025-01-03'])
    })

@pytest.fixture
def test_db_engine():
    """Test database engine"""
    engine = create_engine('sqlite:///:memory:')
    yield engine
    engine.dispose()

def test_transform_sales_data(sample_sales_data):
    """Test sales data transformation"""
    result = transform_sales_data(sample_sales_data)

    assert len(result) == 3
    assert 'revenue' in result.columns
    assert result['revenue'].sum() == 450.0

def test_data_quality_checks(sample_sales_data):
    """Test data quality validation"""
    validator = DataQualityValidator(sample_sales_data)
    results = validator \
        .check_completeness(['transaction_id', 'customer_id']) \
        .check_uniqueness(['transaction_id']) \
        .get_results()

    assert results['all_passed'] is True
```

---

## Real-Time Streaming Templates

### Apache Flink DataStream Job

```java
// FlinkUserEventsProcessor.java
import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.api.common.serialization.SimpleStringSchema;
import org.apache.flink.connector.kafka.source.KafkaSource;
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer;
import org.apache.flink.connector.kafka.sink.KafkaSink;
import org.apache.flink.connector.kafka.sink.KafkaRecordSerializationSchema;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.streaming.api.windowing.assigners.TumblingEventTimeWindows;
import org.apache.flink.streaming.api.windowing.time.Time;
import org.apache.flink.api.common.functions.AggregateFunction;
import org.apache.flink.streaming.api.CheckpointingMode;
import java.time.Duration;

public class FlinkUserEventsProcessor {

    public static void main(String[] args) throws Exception {
        // Create execution environment
        StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();

        // Enable exactly-once checkpointing
        env.enableCheckpointing(60000, CheckpointingMode.EXACTLY_ONCE);
        env.getCheckpointConfig().setMinPauseBetweenCheckpoints(30000);
        env.getCheckpointConfig().setCheckpointTimeout(120000);
        env.getCheckpointConfig().setMaxConcurrentCheckpoints(1);

        // Configure state backend for production
        env.setStateBackend(new RocksDBStateBackend("s3://checkpoints/user-events/", true));

        // Kafka source with exactly-once semantics
        KafkaSource<String> source = KafkaSource.<String>builder()
            .setBootstrapServers("kafka-cluster:9092")
            .setTopics("raw-user-events")
            .setGroupId("flink-user-events-processor")
            .setStartingOffsets(OffsetsInitializer.committedOffsets(OffsetsInitializer.latest()))
            .setValueOnlyDeserializer(new SimpleStringSchema())
            .setProperty("security.protocol", "SASL_SSL")
            .setProperty("sasl.mechanism", "SCRAM-SHA-256")
            .build();

        // Create data stream with event-time watermarks
        DataStream<String> eventsStream = env.fromSource(
            source,
            WatermarkStrategy.<String>forBoundedOutOfOrderness(Duration.ofSeconds(30))
                .withTimestampAssigner((event, timestamp) -> extractTimestamp(event)),
            "Kafka Source"
        );

        // Parse JSON events
        DataStream<UserEvent> parsedEvents = eventsStream
            .map(json -> parseUserEvent(json))
            .filter(event -> event != null)
            .name("Parse Events");

        // Filter for specific event types
        DataStream<UserEvent> filteredEvents = parsedEvents
            .filter(event -> event.getEventType().matches("click|purchase|signup"))
            .name("Filter Events");

        // Enrich with user profiles (async lookup)
        DataStream<EnrichedEvent> enrichedEvents = AsyncDataStream.unorderedWait(
            filteredEvents,
            new UserProfileAsyncFunction(),
            30, TimeUnit.SECONDS,
            100  // Max concurrent requests
        ).name("Enrich Events");

        // Windowed aggregations - 5-minute tumbling windows
        DataStream<EventMetrics> metricsStream = enrichedEvents
            .keyBy(event -> event.getUserId() + ":" + event.getEventType())
            .window(TumblingEventTimeWindows.of(Time.minutes(5)))
            .allowedLateness(Time.minutes(1))
            .sideOutputLateData(lateEventsTag)
            .aggregate(new EventAggregator())
            .name("Aggregate Metrics");

        // Kafka sink with exactly-once delivery
        KafkaSink<String> sink = KafkaSink.<String>builder()
            .setBootstrapServers("kafka-cluster:9092")
            .setRecordSerializer(KafkaRecordSerializationSchema.builder()
                .setTopic("processed-user-events")
                .setValueSerializationSchema(new SimpleStringSchema())
                .build())
            .setDeliverGuarantee(DeliveryGuarantee.EXACTLY_ONCE)
            .setTransactionalIdPrefix("flink-processor")
            .build();

        // Write results
        metricsStream
            .map(metrics -> serializeToJson(metrics))
            .sinkTo(sink)
            .name("Kafka Sink");

        // Handle late data
        DataStream<UserEvent> lateEvents = enrichedEvents
            .getSideOutput(lateEventsTag);

        lateEvents
            .map(event -> serializeToJson(event))
            .sinkTo(dlqSink)
            .name("DLQ Sink");

        // Execute
        env.execute("User Events Processing Pipeline");
    }

    // Custom aggregator for event metrics
    public static class EventAggregator
            implements AggregateFunction<EnrichedEvent, EventMetrics, EventMetrics> {

        @Override
        public EventMetrics createAccumulator() {
            return new EventMetrics();
        }

        @Override
        public EventMetrics add(EnrichedEvent event, EventMetrics acc) {
            acc.incrementCount();
            acc.addValue(event.getValue());
            acc.updateMaxTimestamp(event.getTimestamp());
            return acc;
        }

        @Override
        public EventMetrics getResult(EventMetrics acc) {
            return acc;
        }

        @Override
        public EventMetrics merge(EventMetrics a, EventMetrics b) {
            return a.merge(b);
        }
    }
}
```

### Kafka Streams Application

```java
// KafkaStreamsUserEvents.java
import org.apache.kafka.streams.*;
import org.apache.kafka.streams.kstream.*;
import org.apache.kafka.common.serialization.Serdes;
import java.time.Duration;
import java.util.Properties;

public class KafkaStreamsUserEvents {

    public static void main(String[] args) {
        Properties props = new Properties();
        props.put(StreamsConfig.APPLICATION_ID_CONFIG, "user-events-processor");
        props.put(StreamsConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka-cluster:9092");
        props.put(StreamsConfig.DEFAULT_KEY_SERDE_CLASS_CONFIG, Serdes.String().getClass());
        props.put(StreamsConfig.DEFAULT_VALUE_SERDE_CLASS_CONFIG, Serdes.String().getClass());

        // Exactly-once processing
        props.put(StreamsConfig.PROCESSING_GUARANTEE_CONFIG, StreamsConfig.EXACTLY_ONCE_V2);

        // State store configuration
        props.put(StreamsConfig.STATE_DIR_CONFIG, "/tmp/kafka-streams");
        props.put(StreamsConfig.NUM_STREAM_THREADS_CONFIG, 4);

        // Commit interval
        props.put(StreamsConfig.COMMIT_INTERVAL_MS_CONFIG, 1000);

        StreamsBuilder builder = new StreamsBuilder();

        // Input topic
        KStream<String, String> events = builder.stream("raw-user-events",
            Consumed.with(Serdes.String(), Serdes.String())
                .withTimestampExtractor(new EventTimestampExtractor()));

        // Parse and filter
        KStream<String, UserEvent> parsedEvents = events
            .mapValues(json -> parseUserEvent(json))
            .filter((key, event) -> event != null &&
                event.getEventType().matches("click|purchase|signup"));

        // Branch by event type
        Map<String, KStream<String, UserEvent>> branches = parsedEvents
            .split(Named.as("event-"))
            .branch((key, event) -> event.getEventType().equals("purchase"),
                    Branched.as("purchase"))
            .branch((key, event) -> event.getEventType().equals("click"),
                    Branched.as("click"))
            .defaultBranch(Branched.as("other"));

        // Purchase stream - aggregate revenue
        KTable<Windowed<String>, PurchaseMetrics> purchaseMetrics = branches.get("event-purchase")
            .groupByKey()
            .windowedBy(TimeWindows.ofSizeAndGrace(Duration.ofMinutes(5), Duration.ofMinutes(1)))
            .aggregate(
                PurchaseMetrics::new,
                (key, event, metrics) -> metrics.add(event),
                Materialized.<String, PurchaseMetrics, WindowStore<Bytes, byte[]>>as("purchase-metrics-store")
                    .withKeySerde(Serdes.String())
                    .withValueSerde(purchaseMetricsSerde)
            );

        // Click stream - count by page
        KTable<Windowed<String>, Long> clickCounts = branches.get("event-click")
            .selectKey((key, event) -> event.getPageId())
            .groupByKey()
            .windowedBy(TimeWindows.ofSizeAndGrace(Duration.ofMinutes(1), Duration.ofSeconds(30)))
            .count(Materialized.as("click-counts-store"));

        // Stream-table join for enrichment
        KTable<String, UserProfile> userProfiles = builder.table("user-profiles",
            Consumed.with(Serdes.String(), userProfileSerde));

        KStream<String, EnrichedEvent> enrichedEvents = parsedEvents
            .selectKey((key, event) -> event.getUserId())
            .leftJoin(userProfiles,
                (event, profile) -> enrichEvent(event, profile),
                Joined.with(Serdes.String(), userEventSerde, userProfileSerde));

        // Output to processed topic
        enrichedEvents
            .mapValues(event -> serializeToJson(event))
            .to("processed-user-events", Produced.with(Serdes.String(), Serdes.String()));

        // Output metrics
        purchaseMetrics.toStream()
            .map((windowedKey, metrics) -> KeyValue.pair(
                windowedKey.key(),
                formatMetricsJson(windowedKey, metrics)))
            .to("purchase-metrics", Produced.with(Serdes.String(), Serdes.String()));

        // Build and start
        KafkaStreams streams = new KafkaStreams(builder.build(), props);

        // Graceful shutdown
        Runtime.getRuntime().addShutdownHook(new Thread(streams::close));

        streams.start();
    }
}
```

### Python Flink Job (PyFlink)

```python
# pyflink_user_events.py
from pyflink.datastream import StreamExecutionEnvironment
from pyflink.datastream.connectors.kafka import (
    KafkaSource, KafkaSink, KafkaRecordSerializationSchema,
    KafkaOffsetsInitializer, DeliveryGuarantee
)
from pyflink.common.serialization import SimpleStringSchema
from pyflink.common.watermark_strategy import WatermarkStrategy
from pyflink.datastream.window import TumblingEventTimeWindows
from pyflink.common.time import Time, Duration
from pyflink.datastream.functions import (
    MapFunction, FilterFunction, AggregateFunction,
    ProcessWindowFunction
)
from pyflink.datastream.state import ValueStateDescriptor
from pyflink.common.typeinfo import Types
import json
from datetime import datetime

class ParseEventFunction(MapFunction):
    """Parse JSON events to UserEvent objects"""

    def map(self, value: str):
        try:
            data = json.loads(value)
            return {
                'event_id': data.get('event_id'),
                'user_id': data.get('user_id'),
                'event_type': data.get('event_type'),
                'timestamp': data.get('timestamp'),
                'properties': data.get('properties', {}),
                'value': float(data.get('value', 0))
            }
        except (json.JSONDecodeError, KeyError):
            return None


class FilterValidEvents(FilterFunction):
    """Filter for valid event types"""

    def filter(self, event):
        if event is None:
            return False
        return event.get('event_type') in ['click', 'purchase', 'signup']


class EventAggregator(AggregateFunction):
    """Aggregate events in tumbling windows"""

    def create_accumulator(self):
        return {'count': 0, 'total_value': 0.0, 'max_timestamp': 0}

    def add(self, event, accumulator):
        accumulator['count'] += 1
        accumulator['total_value'] += event.get('value', 0)
        ts = event.get('timestamp', 0)
        if ts > accumulator['max_timestamp']:
            accumulator['max_timestamp'] = ts
        return accumulator

    def get_result(self, accumulator):
        return accumulator

    def merge(self, acc1, acc2):
        return {
            'count': acc1['count'] + acc2['count'],
            'total_value': acc1['total_value'] + acc2['total_value'],
            'max_timestamp': max(acc1['max_timestamp'], acc2['max_timestamp'])
        }


class FormatOutput(ProcessWindowFunction):
    """Format aggregated results for output"""

    def process(self, key, context, elements):
        for element in elements:
            yield json.dumps({
                'key': key,
                'window_start': context.window().start,
                'window_end': context.window().end,
                'count': element['count'],
                'total_value': element['total_value'],
                'avg_value': element['total_value'] / max(element['count'], 1),
                'processed_at': datetime.utcnow().isoformat()
            })


def main():
    # Create execution environment
    env = StreamExecutionEnvironment.get_execution_environment()

    # Enable checkpointing for exactly-once
    env.enable_checkpointing(60000)
    env.get_checkpoint_config().set_checkpointing_mode('EXACTLY_ONCE')
    env.get_checkpoint_config().set_min_pause_between_checkpoints(30000)
    env.get_checkpoint_config().set_checkpoint_timeout(120000)

    # Configure parallelism
    env.set_parallelism(4)

    # Kafka source
    source = KafkaSource.builder() \
        .set_bootstrap_servers("kafka-cluster:9092") \
        .set_topics("raw-user-events") \
        .set_group_id("pyflink-user-events-processor") \
        .set_starting_offsets(KafkaOffsetsInitializer.latest()) \
        .set_value_only_deserializer(SimpleStringSchema()) \
        .set_property("security.protocol", "SASL_SSL") \
        .build()

    # Watermark strategy for event time
    watermark_strategy = WatermarkStrategy \
        .for_bounded_out_of_orderness(Duration.of_seconds(30)) \
        .with_timestamp_assigner(lambda event, _: extract_timestamp(event))

    # Create data stream
    events_stream = env.from_source(
        source,
        watermark_strategy,
        "Kafka Source"
    )

    # Parse events
    parsed_events = events_stream \
        .map(ParseEventFunction()) \
        .filter(FilterValidEvents())

    # Key by user_id + event_type and aggregate
    aggregated = parsed_events \
        .key_by(lambda e: f"{e['user_id']}:{e['event_type']}") \
        .window(TumblingEventTimeWindows.of(Time.minutes(5))) \
        .allowed_lateness(Time.minutes(1)) \
        .aggregate(
            EventAggregator(),
            window_function=FormatOutput()
        )

    # Kafka sink with exactly-once
    sink = KafkaSink.builder() \
        .set_bootstrap_servers("kafka-cluster:9092") \
        .set_record_serializer(
            KafkaRecordSerializationSchema.builder()
                .set_topic("processed-user-events")
                .set_value_serialization_schema(SimpleStringSchema())
                .build()
        ) \
        .set_delivery_guarantee(DeliveryGuarantee.EXACTLY_ONCE) \
        .set_transactional_id_prefix("pyflink-processor") \
        .build()

    # Write to sink
    aggregated.sink_to(sink)

    # Execute
    env.execute("PyFlink User Events Processing")


def extract_timestamp(event_json: str) -> int:
    """Extract event timestamp in milliseconds"""
    try:
        data = json.loads(event_json)
        return int(data.get('timestamp', 0))
    except:
        return 0


if __name__ == "__main__":
    main()
```

### AWS Kinesis Consumer (Python)

```python
# kinesis_consumer.py
import boto3
import json
import time
import logging
from datetime import datetime
from typing import Dict, List, Any, Callable
from botocore.config import Config

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class KinesisEnhancedFanOutConsumer:
    """
    Kinesis consumer with Enhanced Fan-Out for low-latency processing
    """

    def __init__(
        self,
        stream_name: str,
        consumer_name: str,
        region: str = "us-east-1",
        processor: Callable[[Dict], Any] = None
    ):
        self.stream_name = stream_name
        self.consumer_name = consumer_name
        self.region = region
        self.processor = processor or self._default_processor

        # Configure client with retries
        config = Config(
            retries={'max_attempts': 10, 'mode': 'adaptive'},
            connect_timeout=5,
            read_timeout=60
        )

        self.kinesis = boto3.client('kinesis', region_name=region, config=config)
        self.consumer_arn = None
        self.running = False

    def _default_processor(self, record: Dict) -> Any:
        """Default record processor"""
        logger.info(f"Processing record: {record.get('SequenceNumber')}")
        return record

    def register_consumer(self):
        """Register enhanced fan-out consumer"""
        try:
            # Get stream ARN
            stream_desc = self.kinesis.describe_stream(StreamName=self.stream_name)
            stream_arn = stream_desc['StreamDescription']['StreamARN']

            # Register consumer
            response = self.kinesis.register_stream_consumer(
                StreamARN=stream_arn,
                ConsumerName=self.consumer_name
            )
            self.consumer_arn = response['Consumer']['ConsumerARN']

            # Wait for consumer to become active
            while True:
                desc = self.kinesis.describe_stream_consumer(
                    StreamARN=stream_arn,
                    ConsumerName=self.consumer_name
                )
                status = desc['ConsumerDescription']['ConsumerStatus']
                if status == 'ACTIVE':
                    logger.info(f"Consumer {self.consumer_name} is active")
                    break
                elif status == 'CREATING':
                    logger.info("Waiting for consumer to become active...")
                    time.sleep(5)
                else:
                    raise Exception(f"Consumer in unexpected state: {status}")

        except self.kinesis.exceptions.ResourceInUseException:
            # Consumer already exists
            stream_desc = self.kinesis.describe_stream(StreamName=self.stream_name)
            stream_arn = stream_desc['StreamDescription']['StreamARN']

            desc = self.kinesis.describe_stream_consumer(
                StreamARN=stream_arn,
                ConsumerName=self.consumer_name
            )
            self.consumer_arn = desc['ConsumerDescription']['ConsumerARN']
            logger.info(f"Using existing consumer: {self.consumer_arn}")

    def subscribe_to_shard(self, shard_id: str):
        """Subscribe to a single shard with enhanced fan-out"""
        logger.info(f"Subscribing to shard: {shard_id}")

        response = self.kinesis.subscribe_to_shard(
            ConsumerARN=self.consumer_arn,
            ShardId=shard_id,
            StartingPosition={
                'Type': 'LATEST'  # Or 'AT_TIMESTAMP', 'TRIM_HORIZON'
            }
        )

        # Process events from the subscription
        event_stream = response['EventStream']

        for event in event_stream:
            if 'SubscribeToShardEvent' in event:
                shard_event = event['SubscribeToShardEvent']
                records = shard_event['Records']

                for record in records:
                    try:
                        # Decode data
                        data = json.loads(record['Data'].decode('utf-8'))
                        record['ParsedData'] = data

                        # Process record
                        self.processor(record)

                    except json.JSONDecodeError as e:
                        logger.error(f"Failed to parse record: {e}")
                    except Exception as e:
                        logger.error(f"Failed to process record: {e}")

                # Log progress
                continuation_token = shard_event.get('ContinuationSequenceNumber')
                millis_behind = shard_event.get('MillisBehindLatest', 0)
                logger.debug(f"Shard {shard_id}: {len(records)} records, "
                           f"{millis_behind}ms behind latest")

    def start(self):
        """Start consuming from all shards"""
        self.register_consumer()
        self.running = True

        # Get all shards
        stream_desc = self.kinesis.describe_stream(StreamName=self.stream_name)
        shards = stream_desc['StreamDescription']['Shards']

        import threading

        threads = []
        for shard in shards:
            shard_id = shard['ShardId']
            thread = threading.Thread(
                target=self._consume_shard_loop,
                args=(shard_id,),
                daemon=True
            )
            thread.start()
            threads.append(thread)

        logger.info(f"Started {len(threads)} shard consumers")

        # Wait for threads
        for thread in threads:
            thread.join()

    def _consume_shard_loop(self, shard_id: str):
        """Continuously consume from a shard with reconnection"""
        while self.running:
            try:
                self.subscribe_to_shard(shard_id)
            except Exception as e:
                logger.error(f"Shard {shard_id} subscription error: {e}")
                time.sleep(5)  # Wait before reconnecting

    def stop(self):
        """Stop consuming"""
        self.running = False
        logger.info("Consumer stopped")


# Usage example
def process_user_event(record: Dict):
    """Process a single user event"""
    data = record.get('ParsedData', {})
    event_type = data.get('event_type')
    user_id = data.get('user_id')

    logger.info(f"Event: {event_type} from user {user_id}")

    # Add your processing logic here
    # - Enrich with user profile
    # - Aggregate metrics
    # - Write to downstream systems

    return data


if __name__ == "__main__":
    consumer = KinesisEnhancedFanOutConsumer(
        stream_name="user-events-stream",
        consumer_name="events-processor-v1",
        region="us-east-1",
        processor=process_user_event
    )

    try:
        consumer.start()
    except KeyboardInterrupt:
        consumer.stop()
```

### Docker Compose for Streaming Stack

```yaml
# docker-compose-streaming.yaml
version: '3.8'

services:
  # Zookeeper for Kafka
  zookeeper:
    image: confluentinc/cp-zookeeper:7.5.0
    hostname: zookeeper
    container_name: zookeeper
    ports:
      - "2181:2181"
    environment:
      ZOOKEEPER_CLIENT_PORT: 2181
      ZOOKEEPER_TICK_TIME: 2000
    healthcheck:
      test: ["CMD", "nc", "-z", "localhost", "2181"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Kafka Broker
  kafka:
    image: confluentinc/cp-kafka:7.5.0
    hostname: kafka
    container_name: kafka
    depends_on:
      zookeeper:
        condition: service_healthy
    ports:
      - "9092:9092"
      - "29092:29092"
    environment:
      KAFKA_BROKER_ID: 1
      KAFKA_ZOOKEEPER_CONNECT: zookeeper:2181
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,PLAINTEXT_HOST:PLAINTEXT
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:29092,PLAINTEXT_HOST://localhost:9092
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: 0
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'true'
      KAFKA_NUM_PARTITIONS: 6
      KAFKA_DEFAULT_REPLICATION_FACTOR: 1
      KAFKA_LOG_RETENTION_HOURS: 168
      KAFKA_LOG_RETENTION_BYTES: 1073741824
    healthcheck:
      test: ["CMD", "kafka-broker-api-versions", "--bootstrap-server", "localhost:9092"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Schema Registry
  schema-registry:
    image: confluentinc/cp-schema-registry:7.5.0
    hostname: schema-registry
    container_name: schema-registry
    depends_on:
      kafka:
        condition: service_healthy
    ports:
      - "8081:8081"
    environment:
      SCHEMA_REGISTRY_HOST_NAME: schema-registry
      SCHEMA_REGISTRY_KAFKASTORE_BOOTSTRAP_SERVERS: kafka:29092
      SCHEMA_REGISTRY_LISTENERS: http://0.0.0.0:8081
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8081/subjects"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Kafka Connect
  kafka-connect:
    image: confluentinc/cp-kafka-connect:7.5.0
    hostname: kafka-connect
    container_name: kafka-connect
    depends_on:
      kafka:
        condition: service_healthy
      schema-registry:
        condition: service_healthy
    ports:
      - "8083:8083"
    environment:
      CONNECT_BOOTSTRAP_SERVERS: kafka:29092
      CONNECT_REST_ADVERTISED_HOST_NAME: kafka-connect
      CONNECT_REST_PORT: 8083
      CONNECT_GROUP_ID: connect-cluster
      CONNECT_CONFIG_STORAGE_TOPIC: _connect-configs
      CONNECT_CONFIG_STORAGE_REPLICATION_FACTOR: 1
      CONNECT_OFFSET_STORAGE_TOPIC: _connect-offsets
      CONNECT_OFFSET_STORAGE_REPLICATION_FACTOR: 1
      CONNECT_STATUS_STORAGE_TOPIC: _connect-status
      CONNECT_STATUS_STORAGE_REPLICATION_FACTOR: 1
      CONNECT_KEY_CONVERTER: org.apache.kafka.connect.storage.StringConverter
      CONNECT_VALUE_CONVERTER: io.confluent.connect.avro.AvroConverter
      CONNECT_VALUE_CONVERTER_SCHEMA_REGISTRY_URL: http://schema-registry:8081
      CONNECT_PLUGIN_PATH: /usr/share/java,/usr/share/confluent-hub-components
    volumes:
      - ./connect-plugins:/usr/share/confluent-hub-components

  # Flink JobManager
  flink-jobmanager:
    image: flink:1.18-scala_2.12-java11
    hostname: flink-jobmanager
    container_name: flink-jobmanager
    ports:
      - "8084:8081"
    command: jobmanager
    environment:
      - |
        FLINK_PROPERTIES=
        jobmanager.rpc.address: flink-jobmanager
        state.backend: rocksdb
        state.checkpoints.dir: file:///checkpoints
        execution.checkpointing.interval: 60000
        execution.checkpointing.mode: EXACTLY_ONCE
    volumes:
      - flink-checkpoints:/checkpoints
      - ./flink-jobs:/opt/flink/jobs

  # Flink TaskManager
  flink-taskmanager:
    image: flink:1.18-scala_2.12-java11
    hostname: flink-taskmanager
    container_name: flink-taskmanager
    depends_on:
      - flink-jobmanager
    command: taskmanager
    environment:
      - |
        FLINK_PROPERTIES=
        jobmanager.rpc.address: flink-jobmanager
        taskmanager.numberOfTaskSlots: 4
        taskmanager.memory.process.size: 4096m
    volumes:
      - flink-checkpoints:/checkpoints
    deploy:
      replicas: 2

  # Kafka UI
  kafka-ui:
    image: provectuslabs/kafka-ui:latest
    container_name: kafka-ui
    depends_on:
      kafka:
        condition: service_healthy
    ports:
      - "8080:8080"
    environment:
      KAFKA_CLUSTERS_0_NAME: local
      KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS: kafka:29092
      KAFKA_CLUSTERS_0_SCHEMAREGISTRY: http://schema-registry:8081
      KAFKA_CLUSTERS_0_KAFKACONNECT_0_NAME: connect
      KAFKA_CLUSTERS_0_KAFKACONNECT_0_ADDRESS: http://kafka-connect:8083

  # Redis for caching/state
  redis:
    image: redis:7-alpine
    container_name: redis
    ports:
      - "6379:6379"
    command: redis-server --appendonly yes
    volumes:
      - redis-data:/data

  # Elasticsearch for analytics sink
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.11.0
    container_name: elasticsearch
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
      - "ES_JAVA_OPTS=-Xms1g -Xmx1g"
    ports:
      - "9200:9200"
    volumes:
      - elasticsearch-data:/usr/share/elasticsearch/data

volumes:
  flink-checkpoints:
  redis-data:
  elasticsearch-data:

networks:
  default:
    name: streaming-network
```

### Kafka Producer Configuration Template

```properties
# producer.properties - High-throughput exactly-once producer

# Bootstrap servers
bootstrap.servers=kafka-cluster:9092

# Serializers
key.serializer=org.apache.kafka.common.serialization.StringSerializer
value.serializer=org.apache.kafka.common.serialization.StringSerializer

# Exactly-once semantics
enable.idempotence=true
acks=all
retries=2147483647
max.in.flight.requests.per.connection=5

# Transactions for exactly-once
transactional.id=producer-app-001

# Performance tuning
batch.size=65536
linger.ms=10
buffer.memory=67108864
compression.type=lz4

# Reliability
request.timeout.ms=30000
delivery.timeout.ms=120000
max.block.ms=60000

# Security (uncomment for production)
# security.protocol=SASL_SSL
# sasl.mechanism=SCRAM-SHA-256
# sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required \
#   username="producer" \
#   password="password";
# ssl.truststore.location=/path/to/truststore.jks
# ssl.truststore.password=truststore-password
```

### Kafka Consumer Configuration Template

```properties
# consumer.properties - Exactly-once consumer

# Bootstrap servers
bootstrap.servers=kafka-cluster:9092

# Consumer group
group.id=events-processor-v1
group.instance.id=consumer-001

# Deserializers
key.deserializer=org.apache.kafka.common.serialization.StringDeserializer
value.deserializer=org.apache.kafka.common.serialization.StringDeserializer

# Offset management
auto.offset.reset=earliest
enable.auto.commit=false

# Exactly-once reading (for Kafka Streams/transactions)
isolation.level=read_committed

# Performance
fetch.min.bytes=1
fetch.max.wait.ms=500
max.poll.records=500
max.partition.fetch.bytes=1048576

# Session management
session.timeout.ms=45000
heartbeat.interval.ms=15000
max.poll.interval.ms=300000

# Partition assignment
partition.assignment.strategy=org.apache.kafka.clients.consumer.CooperativeStickyAssignor

# Security (uncomment for production)
# security.protocol=SASL_SSL
# sasl.mechanism=SCRAM-SHA-256
# sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required \
#   username="consumer" \
#   password="password";
```

### Streaming Pipeline Configuration (YAML)

```yaml
# streaming_pipeline_config.yaml
# Configuration for stream_processor.py

name: user-events-pipeline
version: "1.0.0"
architecture: kappa

# Source configuration
sources:
  - name: raw-events
    type: kafka
    config:
      bootstrap_servers:
        - kafka-cluster-1:9092
        - kafka-cluster-2:9092
        - kafka-cluster-3:9092
      topic: raw-user-events
      consumer_group: events-processor-v1
      security_protocol: SASL_SSL
      sasl_mechanism: SCRAM-SHA-256
      auto_offset_reset: earliest
      enable_auto_commit: false

# Processing configuration
processing:
  engine: flink
  parallelism: 8
  max_parallelism: 32

  checkpointing:
    enabled: true
    interval_ms: 60000
    mode: exactly_once
    timeout_ms: 120000
    min_pause_ms: 30000
    max_concurrent: 1
    storage: s3://checkpoints/user-events/

  state_backend:
    type: rocksdb
    incremental: true
    local_directory: /tmp/flink-state

  transformations:
    - name: parse_json
      type: map
      function: parse_user_event

    - name: filter_events
      type: filter
      condition: "event_type IN ('click', 'purchase', 'signup')"

    - name: enrich_user
      type: async_lookup
      lookup_table: user_profiles
      join_key: user_id
      timeout_ms: 30000
      capacity: 100

    - name: aggregate_metrics
      type: window_aggregate
      window:
        type: tumbling
        size: 5m
        allowed_lateness: 1m
      group_by:
        - user_id
        - event_type
      aggregations:
        - name: event_count
          function: count
        - name: total_value
          function: sum
          field: value
        - name: avg_value
          function: avg
          field: value

# Sink configuration
sinks:
  - name: processed-events
    type: kafka
    config:
      bootstrap_servers:
        - kafka-cluster-1:9092
      topic: processed-user-events
      exactly_once: true
      transactional_id_prefix: flink-processor

  - name: metrics-sink
    type: kafka
    config:
      topic: event-metrics

  - name: dlq-sink
    type: kafka
    config:
      topic: user-events-dlq
      description: Dead letter queue for failed events

# Quality thresholds
quality:
  max_consumer_lag: 10000
  max_latency_ms: 5000
  max_dlq_rate: 0.01
  data_freshness_minutes: 5

# Monitoring
monitoring:
  metrics_reporter: prometheus
  metrics_port: 9249
  health_check_port: 8080
  alerting:
    slack_webhook: ${SLACK_WEBHOOK_URL}
    pagerduty_key: ${PAGERDUTY_KEY}
```

---

**Last Updated:** December 16, 2025
**Version:** 2.0.0
