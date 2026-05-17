# Data Engineering Frameworks & Patterns

Comprehensive frameworks and methodologies for building world-class data pipelines, ETL systems, and data infrastructure.

## Table of Contents

1. [Data Pipeline Architecture Patterns](#data-pipeline-architecture-patterns)
2. [Data Modeling Frameworks](#data-modeling-frameworks)
3. [ETL/ELT Design Patterns](#etl-elt-design-patterns)
4. [Data Quality Framework](#data-quality-framework)
5. [DataOps Methodology](#dataops-methodology)
6. [Pipeline Orchestration Patterns](#pipeline-orchestration-patterns)
7. [Real-Time Streaming Architecture](#real-time-streaming-architecture)
8. [Data Governance Framework](#data-governance-framework)

---

## Data Pipeline Architecture Patterns

### Lambda Architecture

**Purpose:** Handle both real-time and batch processing with redundancy

**Components:**
- **Batch Layer:** Comprehensive, accurate historical data processing
- **Speed Layer:** Real-time processing for low-latency updates
- **Serving Layer:** Merge batch and real-time views

**When to Use:**
- Need both historical accuracy and real-time updates
- High-volume data ingestion (>1TB/day)
- Tolerance for eventual consistency

**Implementation:**
```
Batch Layer:
- Spark batch jobs on HDFS/S3
- Daily/hourly aggregations
- Full reprocessing capability

Speed Layer:
- Kafka + Spark Streaming
- Incremental updates
- Temporary storage (Redis)

Serving Layer:
- Pre-computed views (Cassandra/HBase)
- Query API for combined results
```

**Pros:**
- Fault-tolerant (batch reprocessing)
- Low latency (speed layer)
- Comprehensive (batch layer)

**Cons:**
- Code duplication (batch + streaming)
- Complex maintenance
- Higher infrastructure cost

### Kappa Architecture

**Purpose:** Simplified streaming-first approach

**Components:**
- **Single Stream Processing Layer:** All data processed as streams
- **Serving Layer:** Query results from stream state

**When to Use:**
- Real-time processing is primary concern
- Data can be reprocessed from stream log
- Simpler operational model preferred

**Implementation:**
```
Stream Processing:
- Kafka as immutable log
- Spark Structured Streaming or Flink
- Stateful stream processing
- Checkpointing for fault tolerance

Serving:
- Stream state stored in databases
- Query APIs on top of state stores
```

**Pros:**
- Simpler codebase (one processing model)
- True real-time processing
- Easier maintenance

**Cons:**
- Requires robust stream log retention
- Complex state management
- Reprocessing can be slower

### Medallion Architecture (Bronze/Silver/Gold)

**Purpose:** Progressive data refinement with clear quality tiers

**Layers:**

**Bronze (Raw):**
- Exact copy of source data
- Minimal transformations
- Schema-on-read
- Audit trail preservation

**Silver (Cleansed):**
- Validated and cleaned data
- Standardized formats
- Business rules applied
- Deduplication

**Gold (Curated):**
- Business-level aggregations
- Feature engineering complete
- Analysis-ready datasets
- Performance-optimized

**When to Use:**
- Data lake/lakehouse architecture
- Multiple data consumers
- Need for data lineage
- Progressive quality improvement

**Implementation:**
```sql
-- Bronze: Raw ingestion
CREATE TABLE bronze.events (
    event_raw STRING,
    ingestion_timestamp TIMESTAMP,
    source_file STRING
);

-- Silver: Cleaned and validated
CREATE TABLE silver.events (
    event_id STRING,
    user_id STRING,
    event_type STRING,
    event_timestamp TIMESTAMP,
    properties MAP<STRING, STRING>,
    quality_flags ARRAY<STRING>
) PARTITIONED BY (date_partition DATE);

-- Gold: Business aggregations
CREATE TABLE gold.daily_user_metrics (
    user_id STRING,
    date DATE,
    total_events INT,
    active_minutes DOUBLE,
    revenue DECIMAL(10,2)
) PARTITIONED BY (date);
```

**Best Practices:**
- Preserve raw data indefinitely
- Version transformations
- Clear promotion criteria (Bronze → Silver → Gold)
- Automated quality checks at each layer

### Microservices Data Architecture

**Purpose:** Distributed data ownership with event-driven integration

**Principles:**
- Database per service
- Event-driven data sharing
- Eventual consistency
- CQRS (Command Query Responsibility Segregation)

**Patterns:**

**Event Sourcing:**
```python
# Example: Order service emitting events
{
  "event_id": "uuid",
  "event_type": "OrderCreated",
  "timestamp": "2025-01-15T10:30:00Z",
  "aggregate_id": "order-123",
  "data": {
    "user_id": "user-456",
    "items": [...],
    "total": 99.99
  }
}
```

**CQRS Pattern:**
- Write model: Event-sourced, optimized for commands
- Read model: Materialized views, optimized for queries
- Async synchronization via event stream

**Data Integration:**
- Kafka for event streaming
- Schema registry for compatibility
- CDC (Change Data Capture) for legacy systems

**When to Use:**
- Microservices architecture
- High write throughput
- Multiple read patterns
- Need for audit trail

---

## Data Modeling Frameworks

### Dimensional Modeling (Kimball)

**Purpose:** Business-friendly data warehouse design

**Key Concepts:**

**Fact Tables:**
- Measures (quantifiable metrics)
- Foreign keys to dimensions
- Grain (level of detail)
- Additive, semi-additive, or non-additive

```sql
CREATE TABLE fact_sales (
    sale_id BIGINT PRIMARY KEY,
    date_key INT REFERENCES dim_date(date_key),
    product_key INT REFERENCES dim_product(product_key),
    customer_key INT REFERENCES dim_customer(customer_key),
    store_key INT REFERENCES dim_store(store_key),
    quantity INT,
    unit_price DECIMAL(10,2),
    total_amount DECIMAL(10,2),
    discount_amount DECIMAL(10,2)
);
```

**Dimension Tables:**
- Descriptive attributes
- Slowly Changing Dimensions (SCD)
- Natural and surrogate keys
- Hierarchies

```sql
CREATE TABLE dim_product (
    product_key INT PRIMARY KEY,  -- Surrogate key
    product_id VARCHAR(50),        -- Natural key
    product_name VARCHAR(200),
    category VARCHAR(100),
    subcategory VARCHAR(100),
    brand VARCHAR(100),
    effective_date DATE,
    expiry_date DATE,
    is_current BOOLEAN
);
```

**SCD Types:**

**Type 1 (Overwrite):**
- No history preservation
- Simple updates

**Type 2 (Add Row):**
- Full history tracking
- Effective/expiry dates
- Current flag

**Type 3 (Add Column):**
- Limited history (previous + current)
- Fast lookups

**Type 4 (History Table):**
- Separate history table
- Current table for fast queries

### Data Vault 2.0

**Purpose:** Enterprise-scale, audit-ready data warehouse

**Core Entities:**

**Hubs (Business Keys):**
```sql
CREATE TABLE hub_customer (
    customer_hash BINARY(32) PRIMARY KEY,
    customer_id VARCHAR(50),
    load_date TIMESTAMP,
    record_source VARCHAR(100)
);
```

**Links (Relationships):**
```sql
CREATE TABLE link_order_customer (
    link_hash BINARY(32) PRIMARY KEY,
    customer_hash BINARY(32),
    order_hash BINARY(32),
    load_date TIMESTAMP,
    record_source VARCHAR(100)
);
```

**Satellites (Attributes):**
```sql
CREATE TABLE sat_customer_details (
    customer_hash BINARY(32),
    load_date TIMESTAMP,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    email VARCHAR(200),
    phone VARCHAR(20),
    PRIMARY KEY (customer_hash, load_date)
);
```

**When to Use:**
- Enterprise data warehouse
- Multiple source systems
- Regulatory compliance needs
- Long-term historical tracking

**Benefits:**
- Parallel loading (hubs, links, satellites)
- Easy source integration
- Complete audit trail
- Scalable architecture

### One Big Table (OBT)

**Purpose:** Denormalized, query-optimized single table

**Characteristics:**
- Pre-joined dimensions and facts
- Columnar storage (Parquet, ORC)
- Partition pruning
- Ideal for cloud data warehouses (BigQuery, Snowflake)

```sql
CREATE TABLE obt_sales_analytics (
    -- Time dimensions
    sale_date DATE,
    sale_timestamp TIMESTAMP,
    year INT,
    quarter INT,
    month INT,
    day_of_week INT,

    -- Product dimensions
    product_id VARCHAR(50),
    product_name VARCHAR(200),
    category VARCHAR(100),
    brand VARCHAR(100),

    -- Customer dimensions
    customer_id VARCHAR(50),
    customer_segment VARCHAR(50),
    customer_lifetime_value DECIMAL(10,2),

    -- Store dimensions
    store_id VARCHAR(50),
    store_region VARCHAR(100),
    store_type VARCHAR(50),

    -- Facts
    quantity INT,
    unit_price DECIMAL(10,2),
    total_amount DECIMAL(10,2),
    cost DECIMAL(10,2),
    profit DECIMAL(10,2)
) PARTITIONED BY (sale_date);
```

**When to Use:**
- Cloud data warehouses with cheap storage
- BI tool performance critical
- Read-heavy workloads
- Simple query patterns

**Trade-offs:**
- Storage cost (denormalization)
- Update complexity
- Dimensional changes require full rebuild

---

## ETL/ELT Design Patterns

### Full Load Pattern

**When to Use:**
- Small datasets (<1GB)
- No reliable change tracking
- Daily snapshot requirements

**Implementation:**
```python
def full_load_pipeline():
    # Extract
    source_data = extract_from_source()

    # Transform
    transformed_data = transform(source_data)

    # Load - Truncate and reload
    target_table.truncate()
    target_table.insert(transformed_data)

    # Archive
    archive_to_s3(transformed_data, date=today)
```

**Pros:** Simple, guaranteed consistency
**Cons:** Inefficient for large datasets

### Incremental Load Pattern

**Change Data Capture (CDC):**
```python
def cdc_pipeline():
    # Get last processed timestamp
    last_timestamp = get_watermark()

    # Extract changes since last run
    changes = extract_changes(since=last_timestamp)

    # Transform
    transformed = transform(changes)

    # Apply changes (upsert)
    for record in transformed:
        if record.operation == 'DELETE':
            target_table.delete(record.key)
        else:
            target_table.upsert(record)

    # Update watermark
    set_watermark(max(changes.timestamp))
```

**Watermark Strategies:**
- Timestamp column (updated_at)
- Sequence number (auto-increment ID)
- Version number
- Batch ID

### Slowly Changing Dimension (SCD) Pattern

**Type 2 Implementation (Full History):**
```sql
-- Check for changes
MERGE INTO dim_customer AS target
USING (
    SELECT
        customer_id,
        first_name,
        last_name,
        email,
        CURRENT_TIMESTAMP AS effective_date
    FROM staging.customer_updates
) AS source
ON target.customer_id = source.customer_id
   AND target.is_current = TRUE

-- Expire old record if changed
WHEN MATCHED AND (
    target.first_name != source.first_name OR
    target.last_name != source.last_name OR
    target.email != source.email
) THEN UPDATE SET
    is_current = FALSE,
    expiry_date = CURRENT_TIMESTAMP

-- Insert new record
WHEN NOT MATCHED THEN INSERT (
    customer_id,
    first_name,
    last_name,
    email,
    effective_date,
    expiry_date,
    is_current
) VALUES (
    source.customer_id,
    source.first_name,
    source.last_name,
    source.email,
    source.effective_date,
    '9999-12-31',
    TRUE
);
```

### Idempotent Pipeline Pattern

**Purpose:** Safe to run multiple times, same result

**Key Techniques:**

**Deduplication:**
```python
def idempotent_load(data, partition_key):
    # Delete existing partition
    target_table.delete_partition(partition_key)

    # Insert deduplicated data
    deduplicated = data.drop_duplicates(subset=['id'])
    target_table.insert(deduplicated)
```

**Upsert with Unique Constraint:**
```sql
INSERT INTO target_table (id, value, updated_at)
VALUES (1, 'data', CURRENT_TIMESTAMP)
ON CONFLICT (id) DO UPDATE SET
    value = EXCLUDED.value,
    updated_at = EXCLUDED.updated_at;
```

**Deterministic Transformations:**
- No random values
- No timestamp generation (use source timestamps)
- Consistent sort orders

---

## Data Quality Framework

### Data Quality Dimensions

**Completeness:**
- Null checks
- Required field validation
- Record count validation

```python
def check_completeness(df):
    checks = []

    # Null checks
    for col in required_columns:
        null_pct = df[col].isnull().mean()
        checks.append({
            'dimension': 'completeness',
            'check': f'{col}_nulls',
            'passed': null_pct < 0.01,
            'value': null_pct
        })

    # Record count
    expected_count = get_expected_count()
    actual_count = len(df)
    checks.append({
        'dimension': 'completeness',
        'check': 'record_count',
        'passed': abs(actual_count - expected_count) / expected_count < 0.05,
        'value': actual_count
    })

    return checks
```

**Accuracy:**
- Data type validation
- Format validation
- Range checks
- Referential integrity

```python
def check_accuracy(df):
    checks = []

    # Email format
    valid_emails = df['email'].str.match(r'^[\w\.-]+@[\w\.-]+\.\w+$')
    checks.append({
        'dimension': 'accuracy',
        'check': 'email_format',
        'passed': valid_emails.mean() > 0.99,
        'value': valid_emails.mean()
    })

    # Amount range
    valid_amounts = (df['amount'] >= 0) & (df['amount'] <= 100000)
    checks.append({
        'dimension': 'accuracy',
        'check': 'amount_range',
        'passed': valid_amounts.mean() > 0.99,
        'value': valid_amounts.mean()
    })

    return checks
```

**Consistency:**
- Cross-field validation
- Temporal consistency
- Aggregate reconciliation

```python
def check_consistency(df):
    checks = []

    # Quantity * price = total
    calculated_total = df['quantity'] * df['unit_price']
    total_diff = (df['total_amount'] - calculated_total).abs()
    checks.append({
        'dimension': 'consistency',
        'check': 'calculated_total',
        'passed': (total_diff < 0.01).mean() > 0.99,
        'value': (total_diff < 0.01).mean()
    })

    return checks
```

**Timeliness:**
- Data freshness checks
- SLA monitoring

```python
def check_timeliness(df):
    checks = []

    # Data freshness
    max_timestamp = df['event_timestamp'].max()
    data_age_hours = (datetime.now() - max_timestamp).total_seconds() / 3600
    checks.append({
        'dimension': 'timeliness',
        'check': 'data_freshness',
        'passed': data_age_hours < 2,
        'value': data_age_hours
    })

    return checks
```

### Great Expectations Integration

```python
import great_expectations as gx

# Create expectation suite
suite = gx.core.ExpectationSuite(
    expectation_suite_name="sales_data_quality"
)

# Add expectations
suite.add_expectation(
    gx.expectations.ExpectColumnValuesToNotBeNull(
        column="order_id"
    )
)

suite.add_expectation(
    gx.expectations.ExpectColumnValuesToBeBetween(
        column="amount",
        min_value=0,
        max_value=100000
    )
)

# Validate
results = context.run_validation_operator(
    "action_list_operator",
    assets_to_validate=[batch],
    run_id=run_id
)
```

---

## DataOps Methodology

### CI/CD for Data Pipelines

**Version Control:**
```
data-pipelines/
├── dags/
│   ├── sales_etl_dag.py
│   └── customer_pipeline_dag.py
├── transforms/
│   ├── dbt_project.yml
│   └── models/
├── tests/
│   ├── test_transforms.py
│   └── test_data_quality.py
└── deployment/
    ├── dev.yaml
    ├── staging.yaml
    └── prod.yaml
```

**Testing Strategy:**

**Unit Tests (Transform Logic):**
```python
def test_calculate_total():
    input_df = pd.DataFrame({
        'quantity': [2, 3],
        'unit_price': [10.0, 20.0]
    })

    result = calculate_total(input_df)

    assert result['total'].tolist() == [20.0, 60.0]
```

**Integration Tests (Pipeline):**
```python
def test_sales_etl_pipeline():
    # Setup test data
    test_input = create_test_data()

    # Run pipeline
    result = run_pipeline(test_input)

    # Validate output
    assert len(result) > 0
    assert result['total'].sum() == expected_total
```

**Data Quality Tests:**
```python
def test_data_quality_checks():
    df = load_test_data()
    checks = run_quality_checks(df)

    failed_checks = [c for c in checks if not c['passed']]
    assert len(failed_checks) == 0, f"Failed checks: {failed_checks}"
```

**Deployment Pipeline:**
```yaml
# .github/workflows/data-pipeline-deploy.yml
name: Data Pipeline Deploy

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Run tests
        run: pytest tests/

  deploy-staging:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to Airflow staging
        run: |
          rsync -avz dags/ airflow-staging:/opt/airflow/dags/

  validate-staging:
    needs: deploy-staging
    runs-on: ubuntu-latest
    steps:
      - name: Run smoke tests
        run: python tests/smoke_tests.py --env staging

  deploy-production:
    needs: validate-staging
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to Airflow production
        run: |
          rsync -avz dags/ airflow-prod:/opt/airflow/dags/
```

### Monitoring and Observability

**Pipeline Metrics:**
- Execution time
- Data volume processed
- Success/failure rate
- Cost per run

**Data Metrics:**
- Data freshness
- Quality score
- Schema changes
- Anomalies detected

**Alerting:**
```python
def pipeline_monitoring():
    metrics = {
        'pipeline': 'sales_etl',
        'execution_time_minutes': execution_time,
        'records_processed': record_count,
        'quality_score': quality_score,
        'timestamp': datetime.now()
    }

    # Alert on SLA breach
    if execution_time > SLA_THRESHOLD:
        send_alert('SLA Breach', metrics)

    # Alert on quality degradation
    if quality_score < QUALITY_THRESHOLD:
        send_alert('Quality Degradation', metrics)

    # Send metrics to monitoring system
    cloudwatch.put_metric_data(metrics)
```

---

## Pipeline Orchestration Patterns

### Airflow DAG Patterns

**Time-Based Scheduling:**
```python
from airflow import DAG
from airflow.operators.python import PythonOperator
from datetime import datetime, timedelta

dag = DAG(
    'sales_etl',
    default_args={
        'owner': 'data-team',
        'retries': 3,
        'retry_delay': timedelta(minutes=5)
    },
    schedule_interval='0 2 * * *',  # Daily at 2 AM
    start_date=datetime(2025, 1, 1),
    catchup=False
)
```

**Task Dependencies:**
```python
# Linear dependency
extract >> transform >> load

# Fan-out
extract >> [transform_sales, transform_customers, transform_products]

# Fan-in
[transform_sales, transform_customers] >> join_data >> load

# Conditional
extract >> branch_task
branch_task >> [process_full_load, process_incremental]
```

**Dynamic Task Generation:**
```python
from airflow.models import Variable

tables = Variable.get("tables_to_process", deserialize_json=True)

for table in tables:
    task = PythonOperator(
        task_id=f'process_{table}',
        python_callable=process_table,
        op_kwargs={'table_name': table},
        dag=dag
    )
```

### Backfill Strategy

```python
def backfill_pipeline(start_date, end_date):
    """
    Idempotent backfill for date range
    """
    dates = pd.date_range(start_date, end_date, freq='D')

    for date in dates:
        try:
            # Process single date partition
            process_date_partition(date)

            # Validate
            validate_partition(date)

            log.info(f"Completed backfill for {date}")
        except Exception as e:
            log.error(f"Failed backfill for {date}: {e}")
            # Continue with next date or stop?
            if not CONTINUE_ON_ERROR:
                raise
```

---

## Real-Time Streaming Architecture

### Kafka-Based Streaming

**Producer Pattern:**
```python
from kafka import KafkaProducer
import json

producer = KafkaProducer(
    bootstrap_servers=['kafka:9092'],
    value_serializer=lambda v: json.dumps(v).encode('utf-8'),
    acks='all',  # Wait for all replicas
    retries=3
)

def send_event(event):
    producer.send(
        topic='user_events',
        key=event['user_id'].encode('utf-8'),
        value=event
    )
```

**Consumer Pattern:**
```python
from kafka import KafkaConsumer

consumer = KafkaConsumer(
    'user_events',
    bootstrap_servers=['kafka:9092'],
    auto_offset_reset='earliest',
    enable_auto_commit=False,
    group_id='event_processor'
)

for message in consumer:
    try:
        event = json.loads(message.value)
        process_event(event)
        consumer.commit()
    except Exception as e:
        log.error(f"Failed to process: {e}")
        # Dead letter queue
        dlq_producer.send('dlq_events', message.value)
```

### Spark Structured Streaming

```python
from pyspark.sql import SparkSession
from pyspark.sql.functions import *

spark = SparkSession.builder.appName("StreamProcessor").getOrCreate()

# Read stream
events_stream = spark.readStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers", "kafka:9092") \
    .option("subscribe", "user_events") \
    .load()

# Transform
parsed_events = events_stream \
    .selectExpr("CAST(value AS STRING) as json") \
    .select(from_json("json", event_schema).alias("data")) \
    .select("data.*")

# Aggregate
user_metrics = parsed_events \
    .groupBy(
        window("timestamp", "1 minute"),
        "user_id"
    ) \
    .agg(
        count("*").alias("event_count"),
        countDistinct("session_id").alias("sessions")
    )

# Write stream
query = user_metrics.writeStream \
    .format("parquet") \
    .option("path", "s3://bucket/user_metrics/") \
    .option("checkpointLocation", "s3://bucket/checkpoints/") \
    .outputMode("append") \
    .trigger(processingTime="1 minute") \
    .start()

query.awaitTermination()
```

### Stateful Stream Processing

**Keyed State Pattern:**
```python
from pyflink.datastream import KeyedProcessFunction
from pyflink.datastream.state import ValueStateDescriptor, ListStateDescriptor

class StatefulAggregator(KeyedProcessFunction):
    """Maintains state per key for running aggregations."""

    def open(self, runtime_context):
        # Value state for running sum
        sum_descriptor = ValueStateDescriptor("running_sum", float)
        self.running_sum = runtime_context.get_state(sum_descriptor)

        # List state for recent values
        list_descriptor = ListStateDescriptor("recent_values", float)
        self.recent_values = runtime_context.get_list_state(list_descriptor)

    def process_element(self, value, ctx):
        # Update running sum
        current_sum = self.running_sum.value() or 0.0
        self.running_sum.update(current_sum + value.amount)

        # Maintain sliding window of recent values
        self.recent_values.add(value.amount)

        # Emit aggregated result
        yield {
            "key": ctx.get_current_key(),
            "running_sum": current_sum + value.amount,
            "count": sum(1 for _ in self.recent_values.get())
        }
```

**State Backend Configuration:**
```python
# RocksDB for large state
env.set_state_backend(RocksDBStateBackend("file:///tmp/state"))

# HashMap for small state (faster but memory-bound)
env.set_state_backend(HashMapStateBackend())

# State TTL configuration
from pyflink.datastream.state import StateTtlConfig, TimeCharacteristic

ttl_config = StateTtlConfig.builder(Time.hours(24)) \
    .set_update_type(StateTtlConfig.UpdateType.OnCreateAndWrite) \
    .set_state_visibility(StateTtlConfig.StateVisibility.NeverReturnExpired) \
    .build()
```

### Stream Joins

**Stream-Stream Join (Windowed):**
```python
# Join two streams within a time window
from pyspark.sql.functions import expr

orders_stream = spark.readStream.format("kafka") \
    .option("subscribe", "orders").load()

payments_stream = spark.readStream.format("kafka") \
    .option("subscribe", "payments").load()

# Join orders with payments within 10-minute window
joined_stream = orders_stream.join(
    payments_stream,
    expr("""
        orders.order_id = payments.order_id AND
        payments.timestamp BETWEEN orders.timestamp AND orders.timestamp + INTERVAL 10 MINUTES
    """),
    "leftOuter"
)
```

**Stream-Table Join (Enrichment):**
```python
# Enrich stream with static reference data
from pyspark.sql.functions import broadcast

# Load reference data (small enough to broadcast)
customers_df = spark.read.parquet("s3://bucket/customers")

# Join streaming orders with customer data
enriched_orders = orders_stream.join(
    broadcast(customers_df),
    orders_stream.customer_id == customers_df.customer_id,
    "left"
)
```

**Temporal Table Join (Flink):**
```java
// Join with versioned table based on event time
Table orders = tableEnv.from("orders_stream");
Table products = tableEnv.from("products_versioned");

Table enrichedOrders = orders.joinLateral(
    products.createTemporalTableFunction(
        $("valid_from"),  // Time attribute
        $("product_id")   // Primary key
    ),
    $("order_product_id").isEqual($("product_id"))
);
```

### Windowing Strategies

**Tumbling Window:**
```python
from pyspark.sql.functions import window

# Non-overlapping fixed-size windows
tumbling_agg = events_stream \
    .groupBy(
        window("timestamp", "5 minutes"),  # 5-minute tumbling window
        "user_id"
    ) \
    .agg(
        count("*").alias("event_count"),
        sum("value").alias("total_value")
    )
```

**Sliding Window:**
```python
# Overlapping windows with slide interval
sliding_agg = events_stream \
    .groupBy(
        window("timestamp", "10 minutes", "2 minutes"),  # 10-min window, 2-min slide
        "category"
    ) \
    .agg(
        avg("value").alias("avg_value"),
        max("value").alias("max_value")
    )
```

**Session Window:**
```python
from pyspark.sql.functions import session_window

# Dynamic windows based on activity gaps
session_agg = events_stream \
    .groupBy(
        session_window("timestamp", "30 minutes"),  # 30-min inactivity gap
        "user_id"
    ) \
    .agg(
        count("*").alias("events_in_session"),
        first("timestamp").alias("session_start"),
        last("timestamp").alias("session_end")
    )
```

**Late Data Handling:**
```python
# Allow late data up to 1 hour
windowed_counts = events_stream \
    .withWatermark("timestamp", "1 hour") \
    .groupBy(
        window("timestamp", "10 minutes"),
        "category"
    ) \
    .count()

# Write with update mode for late data
query = windowed_counts.writeStream \
    .outputMode("update") \
    .format("console") \
    .start()
```

### Exactly-Once Semantics

**Kafka Exactly-Once Producer:**
```python
from kafka import KafkaProducer

producer = KafkaProducer(
    bootstrap_servers=['kafka:9092'],
    acks='all',
    enable_idempotence=True,  # Enable idempotent producer
    max_in_flight_requests_per_connection=5,
    retries=2147483647,
    transactional_id='my-transactional-producer'  # Enable transactions
)

# Initialize transactions
producer.init_transactions()

try:
    producer.begin_transaction()

    # Send multiple messages atomically
    producer.send('topic1', key=b'key1', value=b'value1')
    producer.send('topic2', key=b'key2', value=b'value2')

    # Commit transaction
    producer.commit_transaction()
except Exception as e:
    producer.abort_transaction()
    raise
```

**Flink Exactly-Once Checkpointing:**
```java
StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();

// Enable exactly-once checkpointing
env.enableCheckpointing(60000);  // 60 second interval
env.getCheckpointConfig().setCheckpointingMode(CheckpointingMode.EXACTLY_ONCE);
env.getCheckpointConfig().setMinPauseBetweenCheckpoints(1000);
env.getCheckpointConfig().setCheckpointTimeout(60000);
env.getCheckpointConfig().setMaxConcurrentCheckpoints(1);
env.getCheckpointConfig().setExternalizedCheckpointCleanup(
    ExternalizedCheckpointCleanup.RETAIN_ON_CANCELLATION
);

// Use RocksDB for large state
env.setStateBackend(new EmbeddedRocksDBStateBackend());
env.getCheckpointConfig().setCheckpointStorage("s3://bucket/checkpoints");
```

**End-to-End Exactly-Once:**
```python
# Kafka source -> Flink processing -> Kafka sink with exactly-once

kafka_sink = KafkaSink.builder() \
    .set_bootstrap_servers("kafka:9092") \
    .set_record_serializer(
        KafkaRecordSerializationSchema.builder()
            .set_topic("output-topic")
            .set_value_serialization_schema(SimpleStringSchema())
            .build()
    ) \
    .set_delivery_guarantee(DeliveryGuarantee.EXACTLY_ONCE) \
    .set_transactional_id_prefix("flink-txn") \
    .build()
```

### Event Time Processing

**Watermark Strategies:**
```python
from pyflink.common import WatermarkStrategy, Duration

# Bounded out-of-orderness watermark
watermark_strategy = WatermarkStrategy \
    .for_bounded_out_of_orderness(Duration.of_seconds(10)) \
    .with_timestamp_assigner(lambda event, ts: event.event_time)

# Monotonously increasing timestamps
monotonous_strategy = WatermarkStrategy \
    .for_monotonous_timestamps() \
    .with_timestamp_assigner(lambda event, ts: event.event_time)

# Custom watermark generator
class PunctuatedWatermarkGenerator(WatermarkGenerator):
    def on_event(self, event, timestamp, output):
        if event.is_watermark_marker:
            output.emit_watermark(Watermark(event.watermark_time))

    def on_periodic_emit(self, output):
        pass  # No periodic watermarks
```

**Handling Late Data:**
```java
// Flink side outputs for late data
OutputTag<Event> lateDataTag = new OutputTag<Event>("late-data") {};

SingleOutputStreamOperator<Result> mainStream = eventStream
    .assignTimestampsAndWatermarks(watermarkStrategy)
    .keyBy(Event::getKey)
    .window(TumblingEventTimeWindows.of(Time.minutes(5)))
    .allowedLateness(Time.minutes(1))
    .sideOutputLateData(lateDataTag)
    .process(new MyWindowFunction());

// Get late data stream
DataStream<Event> lateStream = mainStream.getSideOutput(lateDataTag);

// Handle late data separately
lateStream.addSink(new LateDataSink());
```

### Backpressure and Flow Control

**Detecting Backpressure:**
```python
# Kafka consumer with backpressure monitoring
from kafka import KafkaConsumer
import time

consumer = KafkaConsumer(
    'my-topic',
    bootstrap_servers=['kafka:9092'],
    max_poll_records=500,  # Limit batch size
    fetch_max_wait_ms=500,
    fetch_min_bytes=1
)

processing_times = []

for message in consumer:
    start = time.time()

    # Process message
    process_message(message)

    elapsed = time.time() - start
    processing_times.append(elapsed)

    # Detect backpressure (processing slower than arrival rate)
    if len(processing_times) > 100:
        avg_time = sum(processing_times[-100:]) / 100
        if avg_time > 0.1:  # >100ms average
            print(f"Backpressure detected! Avg processing: {avg_time:.3f}s")
            # Implement throttling or scaling logic
```

**Rate Limiting:**
```python
from pyspark.sql.streaming import StreamingQuery

# Limit input rate
rate_limited_stream = spark.readStream \
    .format("kafka") \
    .option("maxOffsetsPerTrigger", 10000) \
    .option("kafka.max.poll.records", 500) \
    .load()

# Trigger-based rate control
query = rate_limited_stream.writeStream \
    .trigger(processingTime="10 seconds") \
    .format("parquet") \
    .start()
```

### Apache Flink Patterns

**DataStream API Pattern:**
```java
DataStream<Event> events = env.fromSource(kafkaSource, watermarkStrategy, "kafka");

DataStream<Result> results = events
    .filter(e -> e.getType().equals("purchase"))
    .keyBy(Event::getUserId)
    .window(TumblingEventTimeWindows.of(Time.hours(1)))
    .aggregate(new PurchaseAggregator())
    .filter(r -> r.getTotalAmount() > 100);

results.sinkTo(kafkaSink);
```

**Complex Event Processing (CEP):**
```java
import org.apache.flink.cep.CEP;
import org.apache.flink.cep.pattern.Pattern;

// Define pattern: login -> browse -> purchase within 30 minutes
Pattern<Event, ?> pattern = Pattern.<Event>begin("login")
    .where(e -> e.getType().equals("login"))
    .followedBy("browse")
    .where(e -> e.getType().equals("browse"))
    .followedBy("purchase")
    .where(e -> e.getType().equals("purchase"))
    .within(Time.minutes(30));

PatternStream<Event> patternStream = CEP.pattern(events.keyBy(Event::getUserId), pattern);

DataStream<Alert> alerts = patternStream.process(new PatternProcessFunction<Event, Alert>() {
    @Override
    public void processMatch(Map<String, List<Event>> match, Context ctx, Collector<Alert> out) {
        Event login = match.get("login").get(0);
        Event purchase = match.get("purchase").get(0);
        out.collect(new Alert(login.getUserId(), "Quick conversion detected"));
    }
});
```

**Async I/O Pattern:**
```java
// Asynchronous enrichment from external service
AsyncDataStream.unorderedWait(
    eventStream,
    new AsyncEnrichmentFunction(),
    30,  // timeout
    TimeUnit.SECONDS,
    100  // capacity
);

class AsyncEnrichmentFunction extends RichAsyncFunction<Event, EnrichedEvent> {
    private transient AsyncHttpClient client;

    @Override
    public void asyncInvoke(Event event, ResultFuture<EnrichedEvent> future) {
        CompletableFuture.supplyAsync(() -> {
            // Make async HTTP call
            Response response = client.get("/api/enrich/" + event.getId()).join();
            return new EnrichedEvent(event, response.getBody());
        }).thenAccept(result -> future.complete(Collections.singleton(result)));
    }
}
```

### AWS Kinesis Patterns

**Kinesis Data Streams Producer:**
```python
import boto3
import json

kinesis = boto3.client('kinesis', region_name='us-east-1')

def put_record(stream_name, data, partition_key):
    """Put single record to Kinesis."""
    response = kinesis.put_record(
        StreamName=stream_name,
        Data=json.dumps(data),
        PartitionKey=partition_key
    )
    return response['SequenceNumber']

def put_records_batch(stream_name, records):
    """Put batch of records with retry logic."""
    kinesis_records = [
        {
            'Data': json.dumps(r['data']),
            'PartitionKey': r['partition_key']
        }
        for r in records
    ]

    response = kinesis.put_records(
        StreamName=stream_name,
        Records=kinesis_records
    )

    # Handle failed records
    if response['FailedRecordCount'] > 0:
        failed = [r for r, resp in zip(records, response['Records'])
                  if 'ErrorCode' in resp]
        # Retry failed records
        put_records_batch(stream_name, failed)
```

**Kinesis Consumer with KCL:**
```python
from amazon_kclpy import kcl
from amazon_kclpy.kcl import RecordProcessorBase

class MyRecordProcessor(RecordProcessorBase):
    def __init__(self):
        self.checkpoint_freq = 100
        self.record_count = 0

    def process_records(self, records, checkpointer):
        for record in records:
            data = json.loads(record.get('data'))
            # Process record
            self.process_single_record(data)
            self.record_count += 1

        # Checkpoint after processing batch
        if self.record_count >= self.checkpoint_freq:
            checkpointer.checkpoint()
            self.record_count = 0

    def shutdown(self, checkpointer, reason):
        if reason == 'TERMINATE':
            checkpointer.checkpoint()
```

**Enhanced Fan-Out Consumer:**
```python
import boto3

kinesis = boto3.client('kinesis', region_name='us-east-1')

# Register consumer for enhanced fan-out
response = kinesis.register_stream_consumer(
    StreamARN='arn:aws:kinesis:us-east-1:123456789012:stream/my-stream',
    ConsumerName='my-efo-consumer'
)

consumer_arn = response['Consumer']['ConsumerARN']

# Subscribe to shard with enhanced fan-out
def subscribe_to_shard(consumer_arn, shard_id):
    response = kinesis.subscribe_to_shard(
        ConsumerARN=consumer_arn,
        ShardId=shard_id,
        StartingPosition={'Type': 'LATEST'}
    )

    for event in response['EventStream']:
        if 'SubscribeToShardEvent' in event:
            for record in event['SubscribeToShardEvent']['Records']:
                yield record
```

### Change Data Capture (CDC) for Streaming

**Debezium CDC Pattern:**
```json
{
  "name": "postgres-cdc-connector",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "database.hostname": "postgres",
    "database.port": "5432",
    "database.user": "debezium",
    "database.password": "${DB_PASSWORD}",
    "database.dbname": "mydb",
    "database.server.name": "dbserver1",
    "table.include.list": "public.orders,public.customers",
    "plugin.name": "pgoutput",
    "publication.autocreate.mode": "filtered",
    "slot.name": "debezium_slot",
    "heartbeat.interval.ms": 10000,
    "transforms": "route",
    "transforms.route.type": "org.apache.kafka.connect.transforms.RegexRouter",
    "transforms.route.regex": "([^.]+)\\.([^.]+)\\.([^.]+)",
    "transforms.route.replacement": "cdc.$3"
  }
}
```

**Processing CDC Events:**
```python
def process_cdc_event(event):
    """Process Debezium CDC event."""
    payload = event['payload']
    operation = payload['op']

    if operation == 'c':  # Create/Insert
        handle_insert(payload['after'])
    elif operation == 'u':  # Update
        handle_update(payload['before'], payload['after'])
    elif operation == 'd':  # Delete
        handle_delete(payload['before'])
    elif operation == 'r':  # Read (snapshot)
        handle_snapshot(payload['after'])

def handle_update(before, after):
    """Handle CDC update event with change tracking."""
    changes = {}
    for key in after.keys():
        if before.get(key) != after.get(key):
            changes[key] = {
                'old': before.get(key),
                'new': after.get(key)
            }

    if changes:
        emit_change_event({
            'operation': 'UPDATE',
            'table': event['source']['table'],
            'primary_key': extract_pk(after),
            'changes': changes,
            'timestamp': event['ts_ms']
        })
```

**CDC to Streaming Pipeline:**
```python
# CDC events -> Kafka -> Flink -> Data Lake

# Flink CDC Source
from pyflink.datastream.connectors import FlinkKafkaConsumer

cdc_source = FlinkKafkaConsumer(
    topics='cdc.orders',
    deserialization_schema=JsonRowDeserializationSchema.builder()
        .typeInfo(cdc_type_info)
        .build(),
    properties=kafka_properties
)

env.add_source(cdc_source) \
    .map(parse_cdc_event) \
    .filter(lambda e: e['op'] in ['c', 'u', 'd']) \
    .key_by(lambda e: e['after']['id'] if e['after'] else e['before']['id']) \
    .process(CDCMergeFunction()) \
    .add_sink(delta_lake_sink)
```

---

## Data Governance Framework

### Data Catalog

**Metadata Management:**
```python
# Example: AWS Glue Catalog
import boto3

glue = boto3.client('glue')

# Register table
glue.create_table(
    DatabaseName='analytics',
    TableInput={
        'Name': 'customer_events',
        'Description': 'Customer behavior events',
        'Owner': 'data-team',
        'StorageDescriptor': {
            'Columns': [
                {'Name': 'event_id', 'Type': 'string'},
                {'Name': 'user_id', 'Type': 'string'},
                {'Name': 'event_type', 'Type': 'string'},
                {'Name': 'timestamp', 'Type': 'timestamp'}
            ],
            'Location': 's3://bucket/customer_events/',
            'InputFormat': 'org.apache.hadoop.mapred.TextInputFormat',
            'OutputFormat': 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
            'SerdeInfo': {
                'SerializationLibrary': 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe'
            }
        },
        'PartitionKeys': [
            {'Name': 'date', 'Type': 'string'}
        ],
        'Parameters': {
            'classification': 'json',
            'data_quality_status': 'verified',
            'pii_fields': 'user_id,email',
            'retention_days': '90'
        }
    }
)
```

### Data Lineage

**Column-Level Lineage:**
```python
# Example lineage tracking
lineage = {
    'table': 'gold.user_metrics',
    'column': 'total_revenue',
    'upstream_dependencies': [
        {
            'table': 'silver.orders',
            'column': 'order_total',
            'transformation': 'SUM(order_total)'
        },
        {
            'table': 'silver.refunds',
            'column': 'refund_amount',
            'transformation': 'SUM(order_total) - SUM(refund_amount)'
        }
    ],
    'downstream_consumers': [
        'dashboard.revenue_report',
        'ml_model.churn_prediction'
    ]
}
```

### Access Control

**Row-Level Security:**
```sql
-- Create security policy
CREATE POLICY customer_data_access ON customer_table
FOR SELECT
USING (
    -- Data scientists can see all
    current_user IN (SELECT user FROM role_members WHERE role = 'data_scientist')
    OR
    -- Regional managers see their region only
    (current_user IN (SELECT user FROM role_members WHERE role = 'regional_manager')
     AND region = current_setting('app.user_region'))
);
```

**Column-Level Security:**
```sql
-- Mask PII for non-privileged users
CREATE VIEW customer_view AS
SELECT
    customer_id,
    CASE
        WHEN current_user IN (SELECT user FROM privileged_users)
        THEN email
        ELSE '***@' || split_part(email, '@', 2)
    END AS email,
    CASE
        WHEN current_user IN (SELECT user FROM privileged_users)
        THEN phone
        ELSE 'XXX-XXX-' || right(phone, 4)
    END AS phone
FROM customer_table;
```

---

## Best Practices Summary

### Pipeline Design
1. Idempotent operations
2. Incremental processing where possible
3. Clear data lineage
4. Comprehensive error handling
5. Automated recovery mechanisms

### Performance
1. Partition large tables (date, region)
2. Use columnar formats (Parquet, ORC)
3. Predicate pushdown
4. Broadcast joins for small tables
5. Caching intermediate results

### Reliability
1. Retry logic with exponential backoff
2. Dead letter queues
3. Circuit breakers
4. Graceful degradation
5. Monitoring and alerting

### Maintainability
1. Version control everything
2. Automated testing
3. Clear documentation
4. Consistent naming conventions
5. Modular, reusable code

---

**Last Updated:** 2025-11-08
**Version:** 1.0.0
