# Data Engineering Python Tools

Complete documentation for the data engineering Python automation tools.

## Table of Contents

1. [pipeline_orchestrator.py](#pipeline_orchestratorpy)
2. [data_quality_validator.py](#data_quality_validatorpy)
3. [etl_performance_optimizer.py](#etl_performance_optimizerpy)
4. [stream_processor.py](#stream_processorpy)
5. [streaming_quality_validator.py](#streaming_quality_validatorpy)
6. [kafka_config_generator.py](#kafka_config_generatorpy)
7. [Tool Integration Patterns](#tool-integration-patterns)
8. [Best Practices](#best-practices)

---

## pipeline_orchestrator.py

**Purpose:** Automated pipeline orchestration and dependency management for complex data workflows.

### Overview

The Pipeline Orchestrator generates production-ready Airflow DAGs with intelligent dependency resolution, retry logic, and monitoring. It supports batch, incremental, and streaming pipelines across multiple data sources.

### Features

- **Automatic DAG Generation:** Create Airflow DAGs from YAML configuration
- **Dependency Resolution:** Smart task ordering based on data dependencies
- **Error Handling:** Built-in retry logic with exponential backoff
- **Monitoring:** Integrated alerting and metrics collection
- **Multi-Source Support:** PostgreSQL, MySQL, S3, GCS, BigQuery, Snowflake
- **Pipeline Templates:** Pre-built patterns for common workflows

### Installation

```bash
pip install apache-airflow pandas sqlalchemy pyyaml boto3 google-cloud-bigquery snowflake-connector-python
```

### Usage

#### Basic Usage

```bash
# Generate DAG from configuration
python scripts/pipeline_orchestrator.py --config pipeline_config.yaml --output dags/

# Validate configuration without generating
python scripts/pipeline_orchestrator.py --config pipeline_config.yaml --validate

# Generate with specific template
python scripts/pipeline_orchestrator.py --template incremental --output dags/
```

#### Configuration File Format

```yaml
# pipeline_config.yaml
pipeline:
  name: sales_etl_pipeline
  description: Daily sales data ETL pipeline
  schedule: "0 2 * * *"  # Cron schedule
  start_date: "2025-01-01"
  catchup: false
  tags:
    - sales
    - production

default_args:
  owner: data-team
  email: alerts@company.com
  retries: 3
  retry_delay_minutes: 5

sources:
  - name: sales_db
    type: postgresql
    connection_id: postgres_prod
    tables:
      - sales_transactions
      - customer_master
      - product_catalog

  - name: s3_raw
    type: s3
    bucket: raw-data
    prefix: sales/

transformations:
  - name: clean_sales_data
    type: python
    function: transform.clean_sales
    depends_on:
      - extract_sales_transactions

  - name: enrich_with_customer
    type: sql
    query_file: sql/enrich_customer.sql
    depends_on:
      - clean_sales_data
      - extract_customer_master

  - name: calculate_metrics
    type: spark
    script: spark/calculate_metrics.py
    depends_on:
      - enrich_with_customer

targets:
  - name: snowflake_warehouse
    type: snowflake
    connection_id: snowflake_prod
    database: ANALYTICS
    schema: SALES
    table: sales_fact

quality_checks:
  - type: row_count
    threshold: 0.95  # Must be within 95% of expected

  - type: null_check
    columns:
      - transaction_id
      - customer_id
      - amount

  - type: custom
    function: validate.check_revenue_consistency

notifications:
  on_failure:
    - email: data-team@company.com
    - slack: "#data-alerts"
  on_success:
    - slack: "#data-pipeline-success"
```

#### Advanced Usage

**Custom Transformation Functions:**

```python
# transform.py
def clean_sales(df):
    """Custom transformation function"""
    df = df.dropna(subset=['transaction_id', 'customer_id'])
    df['amount'] = df['amount'].astype(float)
    df['transaction_date'] = pd.to_datetime(df['transaction_date'])
    return df
```

**Incremental Loading:**

```yaml
pipeline:
  name: incremental_sales_load
  load_strategy: incremental

incremental_config:
  watermark_column: updated_at
  watermark_table: staging.watermarks
  lookback_hours: 24
```

**Parallel Execution:**

```yaml
transformations:
  - name: process_region_1
    type: python
    function: process_region
    params:
      region: us-east

  - name: process_region_2
    type: python
    function: process_region
    params:
      region: us-west

  - name: combine_regions
    depends_on:
      - process_region_1
      - process_region_2
```

### Generated DAG Structure

The tool generates a complete Airflow DAG with:

```python
from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.providers.postgres.operators.postgres import PostgresOperator
from datetime import datetime, timedelta

# Auto-generated configuration
default_args = {
    'owner': 'data-team',
    'retries': 3,
    'retry_delay': timedelta(minutes=5),
    # ... more config
}

# DAG definition
with DAG(
    dag_id='sales_etl_pipeline',
    default_args=default_args,
    schedule_interval='0 2 * * *',
    start_date=datetime(2025, 1, 1),
    catchup=False
) as dag:

    # Auto-generated tasks with dependencies
    extract_task >> transform_task >> load_task >> quality_check_task
```

### Command-Line Options

```
Options:
  --config PATH          Configuration file (YAML/JSON)
  --output PATH          Output directory for DAGs
  --template TYPE        Pipeline template (batch/incremental/streaming)
  --validate             Validate configuration only
  --dry-run             Generate DAG without writing files
  --airflow-version VER  Target Airflow version (default: 2.7)
  --help                Show this message and exit
```

### Output

The tool generates:
- `{pipeline_name}_dag.py` - Complete Airflow DAG
- `{pipeline_name}_config.json` - Runtime configuration
- `README.md` - Pipeline documentation
- `tests/test_{pipeline_name}.py` - Unit tests

### Integration Examples

**Jira Integration (Task Tracking):**

```yaml
notifications:
  on_failure:
    - jira:
        project: DATA
        issue_type: Bug
        priority: High
```

**Datadog Metrics:**

```yaml
monitoring:
  datadog:
    enabled: true
    metrics:
      - pipeline.execution_time
      - pipeline.row_count
      - pipeline.data_quality_score
```

**Slack Notifications:**

```yaml
notifications:
  on_success:
    - slack:
        channel: "#data-pipeline"
        username: "Data Bot"
        message: "Pipeline {{ dag.dag_id }} completed successfully"
```

---

## data_quality_validator.py

**Purpose:** Comprehensive data quality validation framework with automated checks and reporting.

### Overview

The Data Quality Validator implements a complete data quality framework covering completeness, accuracy, consistency, timeliness, and validity dimensions. It integrates with Great Expectations and supports custom validation rules.

### Features

- **Multi-Dimensional Validation:** Completeness, accuracy, consistency, timeliness, validity
- **Automated Anomaly Detection:** Statistical outlier detection
- **Schema Validation:** Detect schema drift and incompatibilities
- **Great Expectations Integration:** Leverage existing expectation suites
- **Custom Rules Engine:** Define business-specific validation rules
- **HTML/PDF Reports:** Generate executive-friendly quality reports

### Installation

```bash
pip install pandas numpy great-expectations scikit-learn matplotlib seaborn jinja2
```

### Usage

#### Basic Usage

```bash
# Validate CSV file
python scripts/data_quality_validator.py --input data/sales.csv --output report.html

# Validate database table
python scripts/data_quality_validator.py \
    --connection postgresql://user:pass@host/db \
    --table sales_transactions \
    --output report.json

# Validate with custom rules
python scripts/data_quality_validator.py \
    --input data/sales.csv \
    --rules rules/sales_validation.yaml \
    --threshold 0.95
```

#### Configuration File

```yaml
# sales_validation.yaml
validation_rules:
  completeness:
    required_columns:
      - transaction_id
      - customer_id
      - amount
      - transaction_date
    null_threshold: 0.01  # Max 1% nulls allowed

  uniqueness:
    unique_columns:
      - transaction_id
    compound_keys:
      - [customer_id, transaction_date, product_id]

  accuracy:
    numeric_ranges:
      amount:
        min: 0
        max: 1000000
      quantity:
        min: 1
        max: 10000

    format_validation:
      email:
        regex: "^[\\w\\.-]+@[\\w\\.-]+\\.\\w+$"
      phone:
        regex: "^\\+?1?\\d{10,15}$"

  consistency:
    cross_field_checks:
      - name: calculated_total
        rule: "quantity * unit_price == total_amount"
        tolerance: 0.01

      - name: date_order
        rule: "order_date <= ship_date"

  timeliness:
    freshness:
      column: updated_at
      max_age_hours: 24

  referential_integrity:
    foreign_keys:
      customer_id:
        reference_table: dim_customer
        reference_column: customer_id
      product_id:
        reference_table: dim_product
        reference_column: product_id

custom_checks:
  - name: revenue_consistency
    description: "Daily revenue should be within 20% of 7-day average"
    query: |
      WITH daily_revenue AS (
        SELECT DATE(transaction_date) as date, SUM(amount) as revenue
        FROM sales_transactions
        GROUP BY 1
      ),
      rolling_avg AS (
        SELECT
          date,
          revenue,
          AVG(revenue) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) as avg_7d
        FROM daily_revenue
      )
      SELECT *
      FROM rolling_avg
      WHERE ABS(revenue - avg_7d) / avg_7d > 0.20
    severity: warning

  - name: duplicate_transactions
    description: "Check for potential duplicate transactions"
    query: |
      SELECT customer_id, amount, transaction_date, COUNT(*) as cnt
      FROM sales_transactions
      WHERE transaction_date >= CURRENT_DATE - 7
      GROUP BY 1, 2, 3
      HAVING COUNT(*) > 1
    severity: error
```

#### Python API

```python
from data_quality_validator import DataQualityValidator

# Initialize validator
validator = DataQualityValidator(
    data_source='postgresql://host/db',
    table='sales_transactions'
)

# Run validation
results = validator.validate(
    rules_file='rules/sales_validation.yaml',
    threshold=0.95
)

# Check results
if results['quality_score'] < 0.95:
    print(f"Quality score: {results['quality_score']}")
    print(f"Failed checks: {results['failed_checks']}")

    # Generate report
    validator.generate_report(
        output='quality_report.html',
        format='html'
    )

    # Raise alert
    if results['critical_failures'] > 0:
        raise ValueError(f"Critical quality issues detected")
```

### Validation Dimensions

**1. Completeness:**
- Null checks
- Missing value detection
- Required field validation

**2. Accuracy:**
- Data type validation
- Format validation (regex)
- Range checks
- Precision validation

**3. Consistency:**
- Cross-field validation
- Referential integrity
- Business rule validation

**4. Timeliness:**
- Data freshness checks
- SLA monitoring
- Update frequency validation

**5. Validity:**
- Schema validation
- Allowed value checks
- Pattern matching

### Output Formats

**JSON Report:**
```json
{
  "quality_score": 0.96,
  "total_checks": 45,
  "passed_checks": 43,
  "failed_checks": 2,
  "critical_failures": 0,
  "dimensions": {
    "completeness": 0.99,
    "accuracy": 0.98,
    "consistency": 0.95,
    "timeliness": 0.97,
    "validity": 0.99
  },
  "failed_checks_detail": [
    {
      "dimension": "consistency",
      "check": "revenue_consistency",
      "severity": "warning",
      "message": "3 records outside acceptable range"
    }
  ]
}
```

**HTML Report:**
- Executive summary dashboard
- Dimension-level breakdowns
- Failed check details
- Trend charts (if historical data available)
- Recommended actions

### Integration with Great Expectations

```python
import great_expectations as gx

# Initialize GE context
context = gx.get_context()

# Run validation with GE suite
validator = DataQualityValidator(df)
ge_results = validator.validate_with_great_expectations(
    expectation_suite='sales_data_quality'
)

# Combine with custom checks
custom_results = validator.validate_custom_rules(
    rules_file='rules/sales_validation.yaml'
)

# Unified report
validator.generate_unified_report(
    ge_results=ge_results,
    custom_results=custom_results,
    output='complete_quality_report.html'
)
```

### Command-Line Options

```
Options:
  --input PATH              Input file or connection string
  --table NAME              Table name (for DB sources)
  --rules PATH              Validation rules file (YAML)
  --threshold FLOAT         Minimum quality score (0-1)
  --output PATH             Output report path
  --format TYPE             Report format (json/html/pdf)
  --fail-on-error          Exit with error if checks fail
  --anomaly-detection      Enable statistical anomaly detection
  --compare-with PATH       Compare with previous run
  --help                   Show this message and exit
```

---

## etl_performance_optimizer.py

**Purpose:** Analyze and optimize ETL pipeline performance with actionable recommendations.

### Overview

The ETL Performance Optimizer analyzes pipeline execution patterns, identifies bottlenecks, and provides specific optimization recommendations. It profiles SQL queries, Spark jobs, and Python transformations.

### Features

- **Execution Profiling:** Detailed timing analysis of pipeline stages
- **Bottleneck Detection:** Identify slowest operations
- **Query Optimization:** Analyze and optimize SQL queries
- **Spark Tuning:** Recommend Spark configuration improvements
- **Cost Analysis:** Calculate and optimize cloud costs
- **Historical Trends:** Track performance over time

### Installation

```bash
pip install pandas numpy matplotlib seaborn sqlparse pyspark boto3
```

### Usage

#### Basic Usage

```bash
# Analyze Airflow DAG performance
python scripts/etl_performance_optimizer.py \
    --airflow-db postgresql://host/airflow \
    --dag-id sales_etl_pipeline \
    --days 30

# Analyze Spark job
python scripts/etl_performance_optimizer.py \
    --spark-history-server http://spark-history:18080 \
    --app-id app-20250115-001 \
    --optimize

# Profile SQL queries
python scripts/etl_performance_optimizer.py \
    --db postgresql://host/db \
    --queries queries/sales_etl.sql \
    --explain-analyze
```

#### Configuration

```yaml
# optimization_config.yaml
profiling:
  enabled: true
  sample_rate: 0.1  # Profile 10% of runs

targets:
  execution_time:
    p50: 300  # 5 minutes
    p95: 600  # 10 minutes
    p99: 900  # 15 minutes

  cost_per_run:
    target: 5.00  # $5 per run
    max: 10.00    # Alert above $10

spark_tuning:
  memory_overhead_factor: 0.1
  adaptive_execution: true
  dynamic_allocation: true

query_optimization:
  explain_plans: true
  index_suggestions: true
  partition_suggestions: true

recommendations:
  priority_levels:
    - critical  # >50% improvement
    - high      # 20-50% improvement
    - medium    # 10-20% improvement
    - low       # <10% improvement
```

#### Python API

```python
from etl_performance_optimizer import PerformanceAnalyzer

# Initialize analyzer
analyzer = PerformanceAnalyzer(
    airflow_db='postgresql://host/airflow'
)

# Analyze DAG
results = analyzer.analyze_dag(
    dag_id='sales_etl_pipeline',
    start_date='2025-01-01',
    end_date='2025-01-15'
)

# Get recommendations
recommendations = analyzer.get_recommendations(
    results,
    priority='high'
)

for rec in recommendations:
    print(f"{rec['priority']}: {rec['title']}")
    print(f"  Expected improvement: {rec['improvement_pct']}%")
    print(f"  Implementation: {rec['implementation']}")
```

### Analysis Outputs

**Performance Report:**

```
ETL Pipeline Performance Analysis
================================

DAG: sales_etl_pipeline
Period: 2025-01-01 to 2025-01-15
Total Runs: 15
Success Rate: 93.3%

Execution Time Metrics:
  P50: 4m 32s
  P95: 8m 12s
  P99: 12m 45s
  Max: 15m 30s

Bottleneck Analysis:
  1. transform_sales_data: 3m 45s (45% of total)
     - Recommendation: Partition input data by date
     - Expected improvement: 40%

  2. load_to_warehouse: 2m 10s (26% of total)
     - Recommendation: Increase batch size
     - Expected improvement: 30%

  3. quality_checks: 1m 30s (18% of total)
     - Recommendation: Parallelize checks
     - Expected improvement: 50%

Cost Analysis:
  Total Cost: $127.50
  Cost per Run: $8.50
  Largest Cost Driver: Spark compute ($95.00)

Optimization Opportunities:
  [CRITICAL] Partition transform_sales_data task
    - Current: Full table scan
    - Recommended: Partition by date
    - Savings: $35/month, 40% faster

  [HIGH] Optimize load_to_warehouse batch size
    - Current: 1000 rows/batch
    - Recommended: 10000 rows/batch
    - Savings: 30% faster

  [HIGH] Add indexes to quality check queries
    - Recommended indexes:
      - sales_transactions(transaction_date, customer_id)
      - customer_master(customer_id)
    - Savings: 50% faster quality checks
```

### Query Optimization

**Automatic SQL Analysis:**

```python
# Analyze slow query
query = """
SELECT c.customer_name, SUM(s.amount) as total
FROM sales_transactions s
JOIN customer_master c ON s.customer_id = c.customer_id
WHERE s.transaction_date >= '2025-01-01'
GROUP BY c.customer_name
ORDER BY total DESC
LIMIT 100
"""

optimizer = QueryOptimizer(connection='postgresql://host/db')
analysis = optimizer.analyze_query(query)

print("Current Execution Plan:")
print(analysis['explain_plan'])

print("\nRecommendations:")
for rec in analysis['recommendations']:
    print(f"- {rec['title']}")
    print(f"  {rec['description']}")
    print(f"  Expected improvement: {rec['improvement']}")

# Example output:
# Recommendations:
# - Add composite index
#   CREATE INDEX idx_sales_date_customer ON sales_transactions(transaction_date, customer_id)
#   Expected improvement: 3x faster

# - Use covering index
#   CREATE INDEX idx_customer_name ON customer_master(customer_id) INCLUDE (customer_name)
#   Expected improvement: 2x faster
```

### Spark Job Tuning

```python
analyzer = SparkPerformanceAnalyzer(
    history_server='http://spark-history:18080'
)

# Analyze Spark application
results = analyzer.analyze_app('app-20250115-001')

print("Spark Configuration Recommendations:")
for rec in results['config_recommendations']:
    print(f"- {rec['parameter']}: {rec['current']} → {rec['recommended']}")
    print(f"  Reason: {rec['reason']}")

# Example output:
# - spark.executor.memory: 4g → 8g
#   Reason: Frequent spill to disk detected
# - spark.sql.shuffle.partitions: 200 → 400
#   Reason: Shuffle stages show small partition sizes
```

### Command-Line Options

```
Options:
  --airflow-db URL          Airflow database connection
  --dag-id NAME             DAG to analyze
  --spark-history URL       Spark history server URL
  --app-id ID               Spark application ID
  --db URL                  Database for query analysis
  --queries PATH            SQL file to analyze
  --days INT                Days of history to analyze
  --optimize                Generate optimization recommendations
  --explain-analyze         Run EXPLAIN ANALYZE on queries
  --output PATH             Output report path
  --format TYPE             Report format (text/html/json)
  --help                    Show this message and exit
```

---

## stream_processor.py

**Purpose:** Generate and validate streaming pipeline configurations for Kafka, Flink, and Kinesis.

### Overview

The Stream Processor generates production-ready streaming pipeline configurations with best practice defaults. It supports multiple streaming platforms and provides validation, scaffolding, and Docker Compose generation for local development.

### Features

- **Multi-Platform Support:** Kafka, Apache Flink, AWS Kinesis, Spark Streaming
- **Configuration Validation:** Best practice checking with warnings and errors
- **Job Scaffolding:** Generate Flink/Spark job templates
- **Topic Configuration:** Kafka topic configs with retention and compaction policies
- **Docker Compose:** Local streaming stack generation
- **Exactly-Once Configuration:** Built-in patterns for exactly-once semantics

### Usage

#### Basic Usage

```bash
# Validate streaming configuration
python scripts/stream_processor.py --config streaming_config.yaml --validate

# Generate Kafka topic configurations
python scripts/stream_processor.py --config streaming_config.yaml --mode kafka --generate --output kafka/

# Generate Flink job scaffolding
python scripts/stream_processor.py --config streaming_config.yaml --mode flink --generate --output flink-jobs/

# Generate Docker Compose for local development
python scripts/stream_processor.py --config streaming_config.yaml --mode docker --generate --output docker/
```

#### Configuration File Format

```yaml
# streaming_config.yaml
name: user-events-pipeline
version: "1.0.0"
architecture: kappa  # kappa or lambda

sources:
  - name: user-events
    type: kafka
    config:
      bootstrap_servers:
        - kafka-cluster:9092
      topic: raw-user-events
      consumer_group: events-processor
      security_protocol: SASL_SSL

processing:
  engine: flink  # flink, spark, kafka-streams
  parallelism: 8
  checkpointing:
    interval_ms: 60000
    mode: exactly_once
    storage: s3://checkpoints/user-events/

  transformations:
    - name: parse_json
      type: map
      function: parse_user_event
    - name: filter_events
      type: filter
      condition: "event_type IN ('click', 'purchase', 'signup')"
    - name: aggregate_metrics
      type: window_aggregate
      window:
        type: tumbling
        size: 5m
      group_by: [user_id, event_type]

sinks:
  - name: processed-events
    type: kafka
    config:
      topic: processed-user-events
      exactly_once: true
  - name: dlq-sink
    type: kafka
    config:
      topic: user-events-dlq

quality:
  max_consumer_lag: 10000
  max_latency_ms: 5000
  max_dlq_rate: 0.01
```

### Command-Line Options

```
Options:
  --config PATH           Streaming configuration file (YAML)
  --mode TYPE             Generation mode: kafka, flink, kinesis, spark, docker
  --validate              Validate configuration only
  --generate              Generate output files
  --output PATH           Output directory
  --format TYPE           Output format: yaml, json, properties
  --version               Show version and exit
  --help                  Show this message and exit
```

### Validation Checks

The validator checks for:

- Required fields (name, sources, sinks)
- Parallelism configuration (recommended: 4-32)
- Checkpoint interval (recommended: 30s-120s)
- Consumer group naming conventions
- Security configuration presence
- Exactly-once compatibility settings

### Generated Outputs

**Kafka Mode:**
- Topic configuration files (.properties)
- Producer/consumer configuration templates
- Schema Registry integration configs

**Flink Mode:**
- Java/Python job scaffolding
- Checkpoint configuration
- State backend configuration
- Kafka connector setup

**Docker Mode:**
- docker-compose.yaml with full streaming stack
- Zookeeper, Kafka, Schema Registry, Flink, Kafka UI

---

## streaming_quality_validator.py

**Purpose:** Real-time data quality monitoring for streaming pipelines.

### Overview

The Streaming Quality Validator monitors the health of streaming pipelines by tracking consumer lag, data freshness, schema drift, throughput metrics, and dead letter queue rates. It provides quality scores and actionable recommendations.

### Features

- **Consumer Lag Monitoring:** Track records behind for consumer groups
- **Data Freshness Validation:** P50/P95/P99 latency measurement
- **Schema Drift Detection:** Field additions, removals, type changes
- **Throughput Analysis:** Events/second and bytes/second metrics
- **Dead Letter Queue Monitoring:** DLQ rate tracking
- **Quality Scoring:** Overall health score with recommendations

### Usage

#### Basic Usage

```bash
# Monitor consumer lag
python scripts/streaming_quality_validator.py \
    --lag \
    --consumer-group events-processor \
    --threshold 10000 \
    --output lag-report.json

# Monitor data freshness
python scripts/streaming_quality_validator.py \
    --freshness \
    --topic processed-user-events \
    --max-latency-ms 5000 \
    --output freshness-report.json

# Monitor throughput
python scripts/streaming_quality_validator.py \
    --throughput \
    --topic raw-user-events \
    --min-events-per-sec 1000 \
    --output throughput-report.json

# Detect schema drift
python scripts/streaming_quality_validator.py \
    --drift \
    --schema-registry http://schema-registry:8081 \
    --subject user-events-value \
    --output drift-report.json

# Monitor dead letter queue
python scripts/streaming_quality_validator.py \
    --dlq \
    --dlq-topic user-events-dlq \
    --main-topic processed-user-events \
    --max-dlq-rate 0.01 \
    --output dlq-report.json

# Full quality validation
python scripts/streaming_quality_validator.py \
    --lag --consumer-group events-processor --threshold 10000 \
    --freshness --topic processed-user-events --max-latency-ms 5000 \
    --throughput --min-events-per-sec 1000 \
    --dlq --dlq-topic user-events-dlq --max-dlq-rate 0.01 \
    --output streaming-quality-report.html
```

### Output Report Format

```json
{
  "timestamp": "2025-12-16T10:30:00Z",
  "overall_health": {
    "status": "HEALTHY",
    "score": 96.5
  },
  "dimensions": {
    "consumer_lag": {
      "status": "OK",
      "value": 2500,
      "threshold": 10000,
      "score": 100
    },
    "data_freshness": {
      "status": "OK",
      "p50_ms": 450,
      "p95_ms": 1200,
      "p99_ms": 2800,
      "threshold_ms": 5000,
      "score": 95
    },
    "throughput": {
      "status": "OK",
      "events_per_sec": 8500,
      "bytes_per_sec": 2125000,
      "threshold": 1000,
      "score": 100
    },
    "schema_drift": {
      "status": "OK",
      "changes_detected": 0,
      "score": 100
    },
    "dlq_rate": {
      "status": "OK",
      "rate": 0.003,
      "threshold": 0.01,
      "score": 90
    }
  },
  "recommendations": [
    "Consider adding more partitions to handle throughput spikes",
    "DLQ rate trending up - investigate failed records"
  ]
}
```

### Command-Line Options

```
Options:
  --lag                     Monitor consumer lag
  --consumer-group NAME     Consumer group to monitor
  --threshold INT           Max acceptable lag (records)

  --freshness               Monitor data freshness
  --topic NAME              Topic to monitor freshness
  --max-latency-ms INT      Max acceptable latency

  --throughput              Monitor throughput
  --min-events-per-sec INT  Minimum events per second

  --drift                   Detect schema drift
  --schema-registry URL     Schema Registry URL
  --subject NAME            Schema subject to monitor

  --dlq                     Monitor dead letter queue
  --dlq-topic NAME          DLQ topic name
  --main-topic NAME         Main topic for rate calculation
  --max-dlq-rate FLOAT      Max acceptable DLQ rate (0-1)

  --output PATH             Output report path
  --format TYPE             Output format: json, html, prometheus
  --continuous              Run continuously (daemon mode)
  --interval INT            Check interval in seconds
  --version                 Show version and exit
  --help                    Show this message and exit
```

### Integration with Monitoring Systems

**Prometheus Metrics Export:**
```bash
python scripts/streaming_quality_validator.py \
    --lag --consumer-group events-processor --threshold 10000 \
    --format prometheus \
    --continuous \
    --port 9249
```

**Exposed Metrics:**
- `streaming_consumer_lag{consumer_group, topic}`
- `streaming_data_freshness_p50_ms{topic}`
- `streaming_data_freshness_p95_ms{topic}`
- `streaming_throughput_events_per_sec{topic}`
- `streaming_dlq_rate{dlq_topic, main_topic}`
- `streaming_overall_health_score`

---

## kafka_config_generator.py

**Purpose:** Generate production-grade Kafka configurations for topics, producers, consumers, and Kafka Streams.

### Overview

The Kafka Config Generator creates optimized Kafka configurations with security, performance, and reliability best practices. It supports multiple profiles for different use cases and generates configurations in multiple formats.

### Features

- **Topic Configuration:** Partitions, replication, retention, compaction
- **Producer Profiles:** High-throughput, exactly-once, low-latency, ordered
- **Consumer Profiles:** Exactly-once, high-throughput, batch processing
- **Kafka Streams Config:** State store tuning, exactly-once processing
- **Security Configuration:** SASL-PLAIN, SASL-SCRAM, mTLS
- **Kafka Connect:** Source and sink connector configurations
- **Multiple Formats:** Properties, YAML, JSON output

### Usage

#### Topic Configuration

```bash
# Generate topic configuration
python scripts/kafka_config_generator.py \
    --topic user-events \
    --partitions 12 \
    --replication 3 \
    --retention-hours 168 \
    --output topics/user-events.properties

# Compacted topic for changelog
python scripts/kafka_config_generator.py \
    --topic user-profiles \
    --partitions 6 \
    --replication 3 \
    --compaction \
    --output topics/user-profiles.properties
```

#### Producer Configuration

```bash
# High-throughput producer
python scripts/kafka_config_generator.py \
    --producer \
    --profile high-throughput \
    --output producer-high-throughput.properties

# Exactly-once producer
python scripts/kafka_config_generator.py \
    --producer \
    --profile exactly-once \
    --transactional-id producer-001 \
    --output producer-exactly-once.properties

# Low-latency producer
python scripts/kafka_config_generator.py \
    --producer \
    --profile low-latency \
    --output producer-low-latency.properties

# Ordered producer (single partition)
python scripts/kafka_config_generator.py \
    --producer \
    --profile ordered \
    --output producer-ordered.properties
```

#### Consumer Configuration

```bash
# Exactly-once consumer
python scripts/kafka_config_generator.py \
    --consumer \
    --profile exactly-once \
    --consumer-group events-processor \
    --output consumer-exactly-once.properties

# High-throughput consumer
python scripts/kafka_config_generator.py \
    --consumer \
    --profile high-throughput \
    --consumer-group batch-processor \
    --output consumer-high-throughput.properties

# Batch processing consumer
python scripts/kafka_config_generator.py \
    --consumer \
    --profile batch \
    --consumer-group daily-aggregator \
    --max-poll-records 1000 \
    --output consumer-batch.properties
```

#### Kafka Streams Configuration

```bash
# Generate Kafka Streams configuration
python scripts/kafka_config_generator.py \
    --streams \
    --application-id user-events-processor \
    --exactly-once \
    --state-dir /data/kafka-streams \
    --output streams-config.properties
```

#### Security Configuration

```bash
# SASL-SCRAM authentication
python scripts/kafka_config_generator.py \
    --security \
    --protocol SASL_SSL \
    --mechanism SCRAM-SHA-256 \
    --username producer \
    --output security-sasl.properties

# mTLS authentication
python scripts/kafka_config_generator.py \
    --security \
    --protocol SSL \
    --keystore /path/to/keystore.jks \
    --truststore /path/to/truststore.jks \
    --output security-mtls.properties
```

#### Kafka Connect Configuration

```bash
# JDBC source connector
python scripts/kafka_config_generator.py \
    --connect-source \
    --connector jdbc \
    --connection-url "jdbc:postgresql://host/db" \
    --table users \
    --output connectors/jdbc-source.json

# S3 sink connector
python scripts/kafka_config_generator.py \
    --connect-sink \
    --connector s3 \
    --bucket data-lake \
    --prefix events/ \
    --output connectors/s3-sink.json
```

### Producer Profiles

| Profile | acks | batch.size | linger.ms | compression | Use Case |
|---------|------|------------|-----------|-------------|----------|
| default | 1 | 16384 | 0 | none | General purpose |
| high-throughput | 1 | 65536 | 10 | lz4 | High volume, some loss OK |
| exactly-once | all | 16384 | 5 | lz4 | Financial, critical data |
| low-latency | 1 | 0 | 0 | none | Real-time applications |
| ordered | all | 16384 | 5 | none | Strict ordering required |

### Consumer Profiles

| Profile | auto.commit | isolation.level | max.poll.records | Use Case |
|---------|-------------|-----------------|------------------|----------|
| default | true | read_uncommitted | 500 | General purpose |
| exactly-once | false | read_committed | 500 | Exactly-once processing |
| high-throughput | true | read_uncommitted | 1000 | High volume processing |
| low-latency | false | read_uncommitted | 100 | Real-time applications |
| batch | false | read_uncommitted | 2000 | Batch processing |

### Command-Line Options

```
Options:
  --topic NAME              Generate topic configuration
  --partitions INT          Number of partitions (default: 6)
  --replication INT         Replication factor (default: 3)
  --retention-hours INT     Retention period in hours
  --compaction              Enable log compaction

  --producer                Generate producer configuration
  --consumer                Generate consumer configuration
  --streams                 Generate Kafka Streams configuration

  --profile NAME            Configuration profile
  --consumer-group NAME     Consumer group ID
  --application-id NAME     Streams application ID
  --transactional-id NAME   Transactional ID for exactly-once

  --security                Generate security configuration
  --protocol TYPE           Security protocol (PLAINTEXT, SSL, SASL_PLAINTEXT, SASL_SSL)
  --mechanism TYPE          SASL mechanism (PLAIN, SCRAM-SHA-256, SCRAM-SHA-512)

  --connect-source          Generate Connect source connector config
  --connect-sink            Generate Connect sink connector config
  --connector TYPE          Connector type (jdbc, s3, elasticsearch, etc.)

  --output PATH             Output file path
  --format TYPE             Output format: properties, yaml, json
  --version                 Show version and exit
  --help                    Show this message and exit
```

### Generated Configuration Examples

**Topic Configuration:**
```properties
# user-events topic configuration
num.partitions=12
replication.factor=3
retention.ms=604800000
segment.bytes=1073741824
cleanup.policy=delete
min.insync.replicas=2
compression.type=producer
```

**Exactly-Once Producer:**
```properties
# Exactly-once producer configuration
bootstrap.servers=kafka-cluster:9092
key.serializer=org.apache.kafka.common.serialization.StringSerializer
value.serializer=org.apache.kafka.common.serialization.StringSerializer
enable.idempotence=true
acks=all
retries=2147483647
max.in.flight.requests.per.connection=5
transactional.id=producer-001
batch.size=16384
linger.ms=5
compression.type=lz4
```

---

## Tool Integration Patterns

### Airflow Integration

```python
from airflow import DAG
from airflow.operators.python import PythonOperator

def run_quality_checks(**context):
    """Airflow task for data quality validation"""
    from data_quality_validator import DataQualityValidator

    validator = DataQualityValidator(
        connection=context['var']['value']['db_connection']
    )

    results = validator.validate(
        rules_file='config/quality_rules.yaml'
    )

    # Push results to XCom
    context['task_instance'].xcom_push(
        key='quality_results',
        value=results
    )

    # Fail task if critical issues
    if results['critical_failures'] > 0:
        raise ValueError("Critical data quality issues detected")

quality_check_task = PythonOperator(
    task_id='quality_checks',
    python_callable=run_quality_checks,
    provide_context=True,
    dag=dag
)
```

### dbt Integration

```yaml
# dbt_project.yml
models:
  my_project:
    staging:
      +post-hook:
        - "{{ run_quality_validation('{{ this }}') }}"

# macros/quality_validation.sql
{% macro run_quality_validation(table_name) %}
  {% set validation_cmd %}
    python scripts/data_quality_validator.py \
      --table {{ table_name }} \
      --rules config/quality_rules.yaml \
      --fail-on-error
  {% endset %}

  {{ run_query(validation_cmd) }}
{% endmacro %}
```

### CI/CD Integration

```yaml
# .github/workflows/data-quality-check.yml
name: Data Quality Check

on:
  pull_request:
    paths:
      - 'dbt/**'
      - 'airflow/dags/**'

jobs:
  quality-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2

      - name: Run data quality validation
        run: |
          python scripts/data_quality_validator.py \
            --connection ${{ secrets.DB_CONNECTION }} \
            --rules config/quality_rules.yaml \
            --output quality-report.json

      - name: Upload report
        uses: actions/upload-artifact@v2
        with:
          name: quality-report
          path: quality-report.json
```

---

## Best Practices

### Pipeline Orchestrator

1. **Configuration Management:**
   - Version control all pipeline configurations
   - Use separate configs for dev/staging/prod
   - Document pipeline dependencies clearly

2. **Error Handling:**
   - Implement retry logic with exponential backoff
   - Use dead letter queues for failed records
   - Set up comprehensive alerting

3. **Performance:**
   - Partition large tables by date
   - Use incremental loading where possible
   - Parallelize independent tasks

4. **Monitoring:**
   - Track execution time trends
   - Monitor data volume processed
   - Alert on SLA breaches

### Data Quality Validator

1. **Rule Definition:**
   - Start with critical business rules
   - Add dimension-specific checks
   - Regularly review and update rules

2. **Thresholds:**
   - Set realistic quality thresholds
   - Use different thresholds for dev vs prod
   - Allow warnings vs errors

3. **Reporting:**
   - Generate reports after each run
   - Trend quality scores over time
   - Share reports with stakeholders

4. **Integration:**
   - Run validation in CI/CD pipeline
   - Block deployments on critical failures
   - Integrate with monitoring tools

### ETL Performance Optimizer

1. **Regular Analysis:**
   - Run performance analysis weekly
   - Compare trends month-over-month
   - Prioritize high-impact optimizations

2. **Optimization Strategy:**
   - Focus on bottlenecks first
   - Test optimizations in dev environment
   - Measure improvement after changes

3. **Cost Management:**
   - Track cost per pipeline run
   - Optimize cloud resource usage
   - Use spot instances where appropriate

4. **Documentation:**
   - Document all optimizations made
   - Track expected vs actual improvements
   - Share learnings with team

---

**Last Updated:** December 16, 2025
**Version:** 2.0.0
