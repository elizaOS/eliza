#!/usr/bin/env python3
"""
Stream Processor - Streaming Pipeline Configuration Generator and Validator

A comprehensive tool for generating and validating streaming pipeline configurations
for Apache Kafka, Apache Flink, and AWS Kinesis. Generates production-ready
configurations, job scaffolding, and Docker Compose files for local development.

Features:
- Streaming pipeline configuration validation (YAML/JSON)
- Kafka topic configuration generator
- Apache Flink job scaffolding (DataStream API)
- AWS Kinesis stream configuration
- Checkpointing and state backend configuration
- Docker Compose for local streaming development

Usage:
    # Validate streaming configuration
    python stream_processor.py --config streaming_config.yaml --validate

    # Generate Kafka topic configuration
    python stream_processor.py --mode kafka --topics orders,users --partitions 12

    # Generate Flink job skeleton
    python stream_processor.py --mode flink --job-name order_processor --input kafka

    # Generate Kinesis stream configuration
    python stream_processor.py --mode kinesis --stream orders --shards 4

    # Generate full streaming pipeline
    python stream_processor.py --config streaming_config.yaml --generate --output-dir ./generated

Author: Claude Skills Team
Version: 1.0.0
"""

import argparse
import json
import os
import sys
import re
from datetime import datetime
from typing import Dict, List, Any, Optional, Tuple
from dataclasses import dataclass, field
from enum import Enum

__version__ = "1.0.0"


class StreamingFramework(Enum):
    """Supported streaming frameworks."""
    FLINK = "flink"
    SPARK_STREAMING = "spark_streaming"
    KAFKA_STREAMS = "kafka_streams"


class SourceType(Enum):
    """Supported source types."""
    KAFKA = "kafka"
    KINESIS = "kinesis"
    PUBSUB = "pubsub"
    FILE = "file"


class SinkType(Enum):
    """Supported sink types."""
    KAFKA = "kafka"
    S3 = "s3"
    POSTGRES = "postgres"
    ELASTICSEARCH = "elasticsearch"
    CONSOLE = "console"


class WindowType(Enum):
    """Supported window types."""
    TUMBLING = "tumbling"
    SLIDING = "sliding"
    SESSION = "session"
    GLOBAL = "global"


class CheckpointMode(Enum):
    """Checkpoint modes."""
    EXACTLY_ONCE = "exactly_once"
    AT_LEAST_ONCE = "at_least_once"


@dataclass
class ValidationResult:
    """Validation result container."""
    is_valid: bool
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    info: List[str] = field(default_factory=list)


@dataclass
class StreamingConfig:
    """Streaming pipeline configuration."""
    name: str
    description: str = ""
    source: Dict[str, Any] = field(default_factory=dict)
    processing: Dict[str, Any] = field(default_factory=dict)
    transformations: List[Dict[str, Any]] = field(default_factory=list)
    sink: Dict[str, Any] = field(default_factory=dict)
    quality_checks: List[Dict[str, Any]] = field(default_factory=list)


class SimpleYamlParser:
    """Simple YAML parser using standard library only."""

    @staticmethod
    def parse(content: str) -> Dict[str, Any]:
        """Parse YAML content to dictionary."""
        result = {}
        current_key = None
        current_list = None
        indent_stack = [(0, result)]

        lines = content.split('\n')
        i = 0

        while i < len(lines):
            line = lines[i]
            stripped = line.strip()

            # Skip empty lines and comments
            if not stripped or stripped.startswith('#'):
                i += 1
                continue

            # Calculate indentation
            indent = len(line) - len(line.lstrip())

            # Handle list items
            if stripped.startswith('- '):
                item_content = stripped[2:].strip()

                # Find the appropriate parent
                while indent_stack and indent_stack[-1][0] >= indent:
                    indent_stack.pop()

                parent = indent_stack[-1][1] if indent_stack else result

                if current_key and current_key in parent:
                    if isinstance(parent[current_key], list):
                        if ':' in item_content:
                            # Dictionary item in list
                            key, value = item_content.split(':', 1)
                            item_dict = {key.strip(): SimpleYamlParser._parse_value(value.strip())}
                            parent[current_key].append(item_dict)
                        else:
                            parent[current_key].append(SimpleYamlParser._parse_value(item_content))
                i += 1
                continue

            # Handle key-value pairs
            if ':' in stripped:
                colon_idx = stripped.index(':')
                key = stripped[:colon_idx].strip()
                value = stripped[colon_idx + 1:].strip()

                # Adjust indent stack
                while indent_stack and indent_stack[-1][0] >= indent:
                    indent_stack.pop()

                parent = indent_stack[-1][1] if indent_stack else result

                if value:
                    # Simple key-value
                    parent[key] = SimpleYamlParser._parse_value(value)
                else:
                    # Check if next line is a list or nested dict
                    if i + 1 < len(lines):
                        next_line = lines[i + 1]
                        next_stripped = next_line.strip()
                        if next_stripped.startswith('- '):
                            parent[key] = []
                            current_key = key
                        else:
                            parent[key] = {}
                            indent_stack.append((indent + 2, parent[key]))
                    else:
                        parent[key] = {}

                current_key = key

            i += 1

        return result

    @staticmethod
    def _parse_value(value: str) -> Any:
        """Parse a YAML value to appropriate Python type."""
        if not value:
            return None

        # Remove quotes
        if (value.startswith('"') and value.endswith('"')) or \
           (value.startswith("'") and value.endswith("'")):
            return value[1:-1]

        # Boolean
        if value.lower() in ('true', 'yes', 'on'):
            return True
        if value.lower() in ('false', 'no', 'off'):
            return False

        # Null
        if value.lower() in ('null', 'none', '~'):
            return None

        # Number
        try:
            if '.' in value:
                return float(value)
            return int(value)
        except ValueError:
            pass

        # List notation [a, b, c]
        if value.startswith('[') and value.endswith(']'):
            items = value[1:-1].split(',')
            return [SimpleYamlParser._parse_value(item.strip()) for item in items if item.strip()]

        return value


class ConfigValidator:
    """Validates streaming pipeline configurations."""

    REQUIRED_FIELDS = ['name', 'source', 'sink']
    VALID_SOURCE_TYPES = ['kafka', 'kinesis', 'pubsub', 'file']
    VALID_SINK_TYPES = ['kafka', 's3', 'postgres', 'elasticsearch', 'console']
    VALID_FRAMEWORKS = ['flink', 'spark_streaming', 'kafka_streams']
    VALID_WINDOW_TYPES = ['tumbling', 'sliding', 'session', 'global']
    VALID_CHECKPOINT_MODES = ['exactly_once', 'at_least_once']

    def __init__(self):
        self.errors: List[str] = []
        self.warnings: List[str] = []
        self.info: List[str] = []

    def validate(self, config: Dict[str, Any]) -> ValidationResult:
        """Validate streaming configuration."""
        self.errors = []
        self.warnings = []
        self.info = []

        # Check required fields
        self._validate_required_fields(config)

        # Validate source configuration
        if 'source' in config:
            self._validate_source(config['source'])

        # Validate processing configuration
        if 'processing' in config:
            self._validate_processing(config['processing'])

        # Validate transformations
        if 'transformations' in config:
            self._validate_transformations(config['transformations'])

        # Validate sink configuration
        if 'sink' in config:
            self._validate_sink(config['sink'])

        # Validate quality checks
        if 'quality_checks' in config:
            self._validate_quality_checks(config['quality_checks'])

        is_valid = len(self.errors) == 0

        return ValidationResult(
            is_valid=is_valid,
            errors=self.errors,
            warnings=self.warnings,
            info=self.info
        )

    def _validate_required_fields(self, config: Dict[str, Any]) -> None:
        """Validate required fields exist."""
        for field in self.REQUIRED_FIELDS:
            if field not in config:
                self.errors.append(f"Missing required field: {field}")

    def _validate_source(self, source: Dict[str, Any]) -> None:
        """Validate source configuration."""
        if 'type' not in source:
            self.errors.append("Source missing 'type' field")
            return

        source_type = source['type'].lower()
        if source_type not in self.VALID_SOURCE_TYPES:
            self.errors.append(f"Invalid source type: {source_type}. Valid types: {self.VALID_SOURCE_TYPES}")

        # Kafka-specific validation
        if source_type == 'kafka':
            if 'topic' not in source and 'topics' not in source:
                self.errors.append("Kafka source requires 'topic' or 'topics' field")
            if 'bootstrap_servers' not in source:
                self.warnings.append("Kafka source missing 'bootstrap_servers' - using default localhost:9092")

        # Kinesis-specific validation
        elif source_type == 'kinesis':
            if 'stream' not in source and 'stream_name' not in source:
                self.errors.append("Kinesis source requires 'stream' or 'stream_name' field")
            if 'region' not in source:
                self.warnings.append("Kinesis source missing 'region' - AWS_REGION environment variable will be used")

    def _validate_processing(self, processing: Dict[str, Any]) -> None:
        """Validate processing configuration."""
        if 'framework' in processing:
            framework = processing['framework'].lower()
            if framework not in self.VALID_FRAMEWORKS:
                self.errors.append(f"Invalid framework: {framework}. Valid frameworks: {self.VALID_FRAMEWORKS}")

        # Validate checkpointing
        if 'checkpointing' in processing:
            checkpoint = processing['checkpointing']
            if 'mode' in checkpoint:
                mode = checkpoint['mode'].lower()
                if mode not in self.VALID_CHECKPOINT_MODES:
                    self.errors.append(f"Invalid checkpoint mode: {mode}. Valid modes: {self.VALID_CHECKPOINT_MODES}")

            if 'interval_ms' in checkpoint:
                interval = checkpoint['interval_ms']
                if interval < 1000:
                    self.warnings.append(f"Checkpoint interval {interval}ms is very low - may impact performance")
                elif interval > 600000:
                    self.warnings.append(f"Checkpoint interval {interval}ms is very high - may increase recovery time")

        # Validate parallelism
        if 'parallelism' in processing:
            parallelism = processing['parallelism']
            if parallelism < 1:
                self.errors.append("Parallelism must be at least 1")
            elif parallelism > 1000:
                self.warnings.append(f"Parallelism {parallelism} is very high - ensure cluster can support")

    def _validate_transformations(self, transformations: List[Dict[str, Any]]) -> None:
        """Validate transformation definitions."""
        valid_transform_types = ['filter', 'map', 'window', 'aggregate', 'join', 'enrich']

        for i, transform in enumerate(transformations):
            if 'type' not in transform:
                self.errors.append(f"Transformation {i} missing 'type' field")
                continue

            transform_type = transform['type'].lower()
            if transform_type not in valid_transform_types:
                self.warnings.append(f"Unknown transformation type: {transform_type}")

            # Window-specific validation
            if transform_type == 'window':
                if 'strategy' not in transform:
                    self.errors.append(f"Window transformation {i} missing 'strategy' field")
                else:
                    strategy = transform['strategy'].lower()
                    if strategy not in self.VALID_WINDOW_TYPES:
                        self.errors.append(f"Invalid window strategy: {strategy}")

                if 'size' not in transform:
                    self.errors.append(f"Window transformation {i} missing 'size' field")

            # Aggregate-specific validation
            elif transform_type == 'aggregate':
                if 'aggregations' not in transform:
                    self.errors.append(f"Aggregate transformation {i} missing 'aggregations' field")

    def _validate_sink(self, sink: Dict[str, Any]) -> None:
        """Validate sink configuration."""
        if 'type' not in sink:
            self.errors.append("Sink missing 'type' field")
            return

        sink_type = sink['type'].lower()
        if sink_type not in self.VALID_SINK_TYPES:
            self.errors.append(f"Invalid sink type: {sink_type}. Valid types: {self.VALID_SINK_TYPES}")

        # Kafka-specific validation
        if sink_type == 'kafka':
            if 'topic' not in sink:
                self.errors.append("Kafka sink requires 'topic' field")

        # S3-specific validation
        elif sink_type == 's3':
            if 'bucket' not in sink and 'path' not in sink:
                self.errors.append("S3 sink requires 'bucket' or 'path' field")

        # Postgres-specific validation
        elif sink_type == 'postgres':
            if 'table' not in sink:
                self.errors.append("Postgres sink requires 'table' field")

    def _validate_quality_checks(self, checks: List[Dict[str, Any]]) -> None:
        """Validate quality check definitions."""
        valid_check_types = ['schema_validation', 'null_check', 'freshness', 'range_check', 'uniqueness']

        for i, check in enumerate(checks):
            if 'type' not in check:
                self.errors.append(f"Quality check {i} missing 'type' field")
                continue

            check_type = check['type'].lower()
            if check_type not in valid_check_types:
                self.info.append(f"Custom quality check type: {check_type}")


class KafkaConfigGenerator:
    """Generates Apache Kafka configurations."""

    DEFAULT_REPLICATION_FACTOR = 3
    DEFAULT_PARTITIONS = 12
    DEFAULT_RETENTION_MS = 604800000  # 7 days

    def __init__(self, verbose: bool = False):
        self.verbose = verbose

    def generate_topic_config(
        self,
        topic_name: str,
        partitions: int = None,
        replication_factor: int = None,
        retention_days: int = None,
        cleanup_policy: str = "delete",
        compression: str = "lz4"
    ) -> Dict[str, Any]:
        """Generate Kafka topic configuration."""
        partitions = partitions or self.DEFAULT_PARTITIONS
        replication_factor = replication_factor or self.DEFAULT_REPLICATION_FACTOR
        retention_ms = (retention_days * 86400000) if retention_days else self.DEFAULT_RETENTION_MS

        config = {
            "topic_name": topic_name,
            "partitions": partitions,
            "replication_factor": replication_factor,
            "configs": {
                "retention.ms": str(retention_ms),
                "cleanup.policy": cleanup_policy,
                "compression.type": compression,
                "min.insync.replicas": str(min(2, replication_factor)),
                "segment.bytes": "1073741824",  # 1GB
                "segment.ms": "86400000",  # 1 day
            },
            "cli_command": self._generate_topic_cli(
                topic_name, partitions, replication_factor, retention_ms, cleanup_policy, compression
            )
        }

        return config

    def _generate_topic_cli(
        self,
        topic_name: str,
        partitions: int,
        replication_factor: int,
        retention_ms: int,
        cleanup_policy: str,
        compression: str
    ) -> str:
        """Generate kafka-topics CLI command."""
        cmd = f"""kafka-topics.sh --create \\
  --topic {topic_name} \\
  --partitions {partitions} \\
  --replication-factor {replication_factor} \\
  --config retention.ms={retention_ms} \\
  --config cleanup.policy={cleanup_policy} \\
  --config compression.type={compression} \\
  --config min.insync.replicas={min(2, replication_factor)} \\
  --bootstrap-server $KAFKA_BOOTSTRAP_SERVERS"""
        return cmd

    def generate_producer_config(self, profile: str = "default") -> Dict[str, Any]:
        """Generate Kafka producer configuration."""
        profiles = {
            "default": {
                "acks": "all",
                "retries": 3,
                "batch.size": 16384,
                "linger.ms": 5,
                "buffer.memory": 33554432,
                "compression.type": "lz4",
                "enable.idempotence": False
            },
            "high_throughput": {
                "acks": "1",
                "retries": 3,
                "batch.size": 65536,
                "linger.ms": 20,
                "buffer.memory": 67108864,
                "compression.type": "lz4",
                "enable.idempotence": False
            },
            "exactly_once": {
                "acks": "all",
                "retries": 2147483647,
                "batch.size": 16384,
                "linger.ms": 5,
                "buffer.memory": 33554432,
                "compression.type": "lz4",
                "enable.idempotence": True,
                "max.in.flight.requests.per.connection": 5,
                "transactional.id": "${TRANSACTIONAL_ID}"
            },
            "low_latency": {
                "acks": "1",
                "retries": 0,
                "batch.size": 0,
                "linger.ms": 0,
                "buffer.memory": 33554432,
                "compression.type": "none",
                "enable.idempotence": False
            }
        }

        if profile not in profiles:
            profile = "default"

        return {
            "profile": profile,
            "config": profiles[profile],
            "description": self._get_profile_description(profile)
        }

    def generate_consumer_config(self, profile: str = "default", group_id: str = None) -> Dict[str, Any]:
        """Generate Kafka consumer configuration."""
        profiles = {
            "default": {
                "group.id": group_id or "${CONSUMER_GROUP}",
                "auto.offset.reset": "earliest",
                "enable.auto.commit": True,
                "auto.commit.interval.ms": 5000,
                "fetch.min.bytes": 1,
                "fetch.max.wait.ms": 500,
                "max.poll.records": 500,
                "session.timeout.ms": 30000,
                "heartbeat.interval.ms": 10000
            },
            "exactly_once": {
                "group.id": group_id or "${CONSUMER_GROUP}",
                "auto.offset.reset": "earliest",
                "enable.auto.commit": False,
                "isolation.level": "read_committed",
                "fetch.min.bytes": 1,
                "fetch.max.wait.ms": 500,
                "max.poll.records": 500,
                "session.timeout.ms": 30000,
                "heartbeat.interval.ms": 10000
            },
            "high_throughput": {
                "group.id": group_id or "${CONSUMER_GROUP}",
                "auto.offset.reset": "earliest",
                "enable.auto.commit": True,
                "auto.commit.interval.ms": 5000,
                "fetch.min.bytes": 50000,
                "fetch.max.wait.ms": 500,
                "max.poll.records": 1000,
                "session.timeout.ms": 30000,
                "heartbeat.interval.ms": 10000
            },
            "low_latency": {
                "group.id": group_id or "${CONSUMER_GROUP}",
                "auto.offset.reset": "latest",
                "enable.auto.commit": True,
                "auto.commit.interval.ms": 1000,
                "fetch.min.bytes": 1,
                "fetch.max.wait.ms": 100,
                "max.poll.records": 100,
                "session.timeout.ms": 10000,
                "heartbeat.interval.ms": 3000
            }
        }

        if profile not in profiles:
            profile = "default"

        return {
            "profile": profile,
            "config": profiles[profile],
            "description": self._get_profile_description(profile)
        }

    def _get_profile_description(self, profile: str) -> str:
        """Get profile description."""
        descriptions = {
            "default": "Balanced configuration for general use",
            "high_throughput": "Optimized for maximum throughput with larger batches",
            "exactly_once": "Ensures exactly-once semantics with idempotent/transactional producers",
            "low_latency": "Minimizes latency at the cost of throughput"
        }
        return descriptions.get(profile, "Custom configuration")


class FlinkJobGenerator:
    """Generates Apache Flink job scaffolding."""

    def __init__(self, verbose: bool = False):
        self.verbose = verbose

    def generate_datastream_job(
        self,
        job_name: str,
        source_type: str = "kafka",
        sink_type: str = "kafka",
        parallelism: int = 4,
        checkpoint_interval: int = 60000,
        checkpoint_mode: str = "exactly_once"
    ) -> Dict[str, Any]:
        """Generate Flink DataStream API job skeleton."""

        python_code = self._generate_pyflink_code(
            job_name, source_type, sink_type, parallelism, checkpoint_interval, checkpoint_mode
        )

        java_code = self._generate_java_code(
            job_name, source_type, sink_type, parallelism, checkpoint_interval, checkpoint_mode
        )

        return {
            "job_name": job_name,
            "configuration": {
                "parallelism": parallelism,
                "checkpoint_interval_ms": checkpoint_interval,
                "checkpoint_mode": checkpoint_mode,
                "state_backend": "rocksdb",
                "restart_strategy": "fixed-delay"
            },
            "python_code": python_code,
            "java_code": java_code,
            "docker_compose": self._generate_flink_docker_compose(),
            "submit_command": self._generate_submit_command(job_name)
        }

    def _generate_pyflink_code(
        self,
        job_name: str,
        source_type: str,
        sink_type: str,
        parallelism: int,
        checkpoint_interval: int,
        checkpoint_mode: str
    ) -> str:
        """Generate PyFlink job code."""
        code = f'''#!/usr/bin/env python3
"""
{job_name} - Flink Streaming Job

Auto-generated streaming job skeleton.
"""

from pyflink.datastream import StreamExecutionEnvironment, RuntimeExecutionMode
from pyflink.datastream.connectors.kafka import KafkaSource, KafkaOffsetsInitializer, KafkaSink, KafkaRecordSerializationSchema
from pyflink.common.serialization import SimpleStringSchema
from pyflink.common import WatermarkStrategy, Duration
from pyflink.datastream.state import ValueStateDescriptor
from pyflink.datastream.functions import KeyedProcessFunction, RuntimeContext


def create_environment():
    """Create and configure Flink execution environment."""
    env = StreamExecutionEnvironment.get_execution_environment()
    env.set_runtime_mode(RuntimeExecutionMode.STREAMING)
    env.set_parallelism({parallelism})

    # Checkpointing configuration
    env.enable_checkpointing({checkpoint_interval})
    checkpoint_config = env.get_checkpoint_config()
    checkpoint_config.set_checkpoint_storage_dir("file:///tmp/flink-checkpoints")
    checkpoint_config.set_min_pause_between_checkpoints(1000)
    checkpoint_config.set_checkpoint_timeout(60000)
    checkpoint_config.set_max_concurrent_checkpoints(1)

    return env


def create_kafka_source(env, topic: str, bootstrap_servers: str, group_id: str):
    """Create Kafka source connector."""
    source = KafkaSource.builder() \\
        .set_bootstrap_servers(bootstrap_servers) \\
        .set_topics(topic) \\
        .set_group_id(group_id) \\
        .set_starting_offsets(KafkaOffsetsInitializer.earliest()) \\
        .set_value_only_deserializer(SimpleStringSchema()) \\
        .build()

    watermark_strategy = WatermarkStrategy \\
        .for_bounded_out_of_orderness(Duration.of_seconds(5))

    return env.from_source(source, watermark_strategy, "Kafka Source")


def create_kafka_sink(topic: str, bootstrap_servers: str):
    """Create Kafka sink connector."""
    return KafkaSink.builder() \\
        .set_bootstrap_servers(bootstrap_servers) \\
        .set_record_serializer(
            KafkaRecordSerializationSchema.builder()
                .set_topic(topic)
                .set_value_serialization_schema(SimpleStringSchema())
                .build()
        ) \\
        .set_delivery_guarantee(DeliveryGuarantee.EXACTLY_ONCE) \\
        .build()


class EventProcessor(KeyedProcessFunction):
    """Custom event processor with state management."""

    def __init__(self):
        self.state = None

    def open(self, runtime_context: RuntimeContext):
        """Initialize state."""
        state_descriptor = ValueStateDescriptor("event_count", int)
        self.state = runtime_context.get_state(state_descriptor)

    def process_element(self, value, ctx):
        """Process each event."""
        # Get current count
        current_count = self.state.value() or 0

        # Update state
        self.state.update(current_count + 1)

        # Emit processed event
        yield f"{{\\\"key\\\": \\\"{{ctx.get_current_key()}}\\\", \\\"count\\\": {{current_count + 1}}, \\\"value\\\": \\\"{{value}}\\\"}}"


def main():
    """Main entry point."""
    # Configuration
    BOOTSTRAP_SERVERS = "localhost:9092"
    SOURCE_TOPIC = "input_topic"
    SINK_TOPIC = "output_topic"
    CONSUMER_GROUP = "{job_name}_consumer"

    # Create environment
    env = create_environment()

    # Create source
    source_stream = create_kafka_source(
        env, SOURCE_TOPIC, BOOTSTRAP_SERVERS, CONSUMER_GROUP
    )

    # Process stream
    processed_stream = source_stream \\
        .map(lambda x: x.upper()) \\
        .key_by(lambda x: x[:1] if x else "default") \\
        .process(EventProcessor())

    # Create sink
    sink = create_kafka_sink(SINK_TOPIC, BOOTSTRAP_SERVERS)
    processed_stream.sink_to(sink)

    # Execute
    env.execute("{job_name}")


if __name__ == "__main__":
    main()
'''
        return code

    def _generate_java_code(
        self,
        job_name: str,
        source_type: str,
        sink_type: str,
        parallelism: int,
        checkpoint_interval: int,
        checkpoint_mode: str
    ) -> str:
        """Generate Java Flink job code."""
        class_name = ''.join(word.capitalize() for word in job_name.replace('-', '_').split('_'))

        code = f'''package com.example.streaming;

import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.api.common.serialization.SimpleStringSchema;
import org.apache.flink.connector.kafka.source.KafkaSource;
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer;
import org.apache.flink.connector.kafka.sink.KafkaSink;
import org.apache.flink.connector.kafka.sink.KafkaRecordSerializationSchema;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.streaming.api.CheckpointingMode;

import java.time.Duration;

/**
 * {job_name} - Flink Streaming Job
 *
 * Auto-generated streaming job skeleton.
 */
public class {class_name} {{

    public static void main(String[] args) throws Exception {{
        // Configuration
        final String bootstrapServers = "localhost:9092";
        final String sourceTopic = "input_topic";
        final String sinkTopic = "output_topic";
        final String consumerGroup = "{job_name}_consumer";

        // Create execution environment
        StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
        env.setParallelism({parallelism});

        // Configure checkpointing
        env.enableCheckpointing({checkpoint_interval});
        env.getCheckpointConfig().setCheckpointingMode(CheckpointingMode.EXACTLY_ONCE);
        env.getCheckpointConfig().setMinPauseBetweenCheckpoints(1000);
        env.getCheckpointConfig().setCheckpointTimeout(60000);
        env.getCheckpointConfig().setMaxConcurrentCheckpoints(1);

        // Create Kafka source
        KafkaSource<String> source = KafkaSource.<String>builder()
            .setBootstrapServers(bootstrapServers)
            .setTopics(sourceTopic)
            .setGroupId(consumerGroup)
            .setStartingOffsets(OffsetsInitializer.earliest())
            .setValueOnlyDeserializer(new SimpleStringSchema())
            .build();

        // Create watermark strategy
        WatermarkStrategy<String> watermarkStrategy = WatermarkStrategy
            .<String>forBoundedOutOfOrderness(Duration.ofSeconds(5));

        // Create source stream
        DataStream<String> sourceStream = env.fromSource(
            source, watermarkStrategy, "Kafka Source");

        // Process stream
        DataStream<String> processedStream = sourceStream
            .map(String::toUpperCase)
            .keyBy(value -> value.isEmpty() ? "default" : value.substring(0, 1))
            .map(value -> String.format("{{\\"value\\": \\"%s\\"}}", value));

        // Create Kafka sink
        KafkaSink<String> sink = KafkaSink.<String>builder()
            .setBootstrapServers(bootstrapServers)
            .setRecordSerializer(
                KafkaRecordSerializationSchema.builder()
                    .setTopic(sinkTopic)
                    .setValueSerializationSchema(new SimpleStringSchema())
                    .build()
            )
            .setDeliveryGuarantee(DeliveryGuarantee.EXACTLY_ONCE)
            .build();

        processedStream.sinkTo(sink);

        // Execute
        env.execute("{job_name}");
    }}
}}
'''
        return code

    def _generate_flink_docker_compose(self) -> str:
        """Generate Docker Compose for Flink cluster."""
        compose = '''version: '3.8'

services:
  jobmanager:
    image: flink:1.18-scala_2.12
    ports:
      - "8081:8081"
    command: jobmanager
    environment:
      - |
        FLINK_PROPERTIES=
        jobmanager.rpc.address: jobmanager
        state.backend: rocksdb
        state.checkpoints.dir: file:///tmp/flink-checkpoints
        state.savepoints.dir: file:///tmp/flink-savepoints
    volumes:
      - flink-checkpoints:/tmp/flink-checkpoints
      - flink-savepoints:/tmp/flink-savepoints

  taskmanager:
    image: flink:1.18-scala_2.12
    depends_on:
      - jobmanager
    command: taskmanager
    scale: 2
    environment:
      - |
        FLINK_PROPERTIES=
        jobmanager.rpc.address: jobmanager
        taskmanager.numberOfTaskSlots: 4
        taskmanager.memory.process.size: 2048m
        state.backend: rocksdb
    volumes:
      - flink-checkpoints:/tmp/flink-checkpoints
      - flink-savepoints:/tmp/flink-savepoints

volumes:
  flink-checkpoints:
  flink-savepoints:
'''
        return compose

    def _generate_submit_command(self, job_name: str) -> str:
        """Generate Flink job submit command."""
        return f'''# Submit PyFlink job
flink run -py {job_name}.py

# Submit Java job
flink run -c com.example.streaming.{job_name.replace("-", "").title()} target/{job_name}.jar

# Submit with savepoint
flink run -s /tmp/flink-savepoints/savepoint-xxx -py {job_name}.py'''


class KinesisConfigGenerator:
    """Generates AWS Kinesis configurations."""

    def __init__(self, verbose: bool = False):
        self.verbose = verbose

    def generate_stream_config(
        self,
        stream_name: str,
        shard_count: int = 4,
        retention_hours: int = 24,
        stream_mode: str = "ON_DEMAND"
    ) -> Dict[str, Any]:
        """Generate Kinesis stream configuration."""

        config = {
            "stream_name": stream_name,
            "shard_count": shard_count if stream_mode == "PROVISIONED" else None,
            "retention_period_hours": retention_hours,
            "stream_mode": stream_mode,
            "encryption": {
                "encryption_type": "KMS",
                "key_id": "alias/aws/kinesis"
            },
            "enhanced_monitoring": {
                "shard_level_metrics": [
                    "IncomingBytes",
                    "IncomingRecords",
                    "OutgoingBytes",
                    "OutgoingRecords",
                    "WriteProvisionedThroughputExceeded",
                    "ReadProvisionedThroughputExceeded",
                    "IteratorAgeMilliseconds"
                ]
            },
            "cli_command": self._generate_stream_cli(stream_name, shard_count, retention_hours, stream_mode),
            "terraform": self._generate_terraform(stream_name, shard_count, retention_hours, stream_mode)
        }

        return config

    def _generate_stream_cli(
        self,
        stream_name: str,
        shard_count: int,
        retention_hours: int,
        stream_mode: str
    ) -> str:
        """Generate AWS CLI command for stream creation."""
        if stream_mode == "ON_DEMAND":
            cmd = f'''aws kinesis create-stream \\
  --stream-name {stream_name} \\
  --stream-mode-details StreamMode=ON_DEMAND

aws kinesis increase-stream-retention-period \\
  --stream-name {stream_name} \\
  --retention-period-hours {retention_hours}'''
        else:
            cmd = f'''aws kinesis create-stream \\
  --stream-name {stream_name} \\
  --shard-count {shard_count}

aws kinesis increase-stream-retention-period \\
  --stream-name {stream_name} \\
  --retention-period-hours {retention_hours}'''

        return cmd

    def _generate_terraform(
        self,
        stream_name: str,
        shard_count: int,
        retention_hours: int,
        stream_mode: str
    ) -> str:
        """Generate Terraform configuration."""
        terraform = f'''resource "aws_kinesis_stream" "{stream_name.replace("-", "_")}" {{
  name             = "{stream_name}"
  retention_period = {retention_hours}

  stream_mode_details {{
    stream_mode = "{stream_mode}"
  }}

  encryption_type = "KMS"
  kms_key_id      = "alias/aws/kinesis"

  shard_level_metrics = [
    "IncomingBytes",
    "IncomingRecords",
    "OutgoingBytes",
    "OutgoingRecords",
    "WriteProvisionedThroughputExceeded",
    "ReadProvisionedThroughputExceeded",
    "IteratorAgeMilliseconds"
  ]

  tags = {{
    Environment = var.environment
    ManagedBy   = "terraform"
  }}
}}'''
        return terraform

    def generate_producer_config(self) -> Dict[str, Any]:
        """Generate Kinesis producer configuration."""
        return {
            "config": {
                "aggregation_enabled": True,
                "aggregation_max_count": 4294967295,
                "aggregation_max_size": 51200,
                "collection_max_count": 500,
                "collection_max_size": 5242880,
                "connect_timeout": 6000,
                "credentials_refresh_delay": 5000,
                "enable_core_dumps": False,
                "fail_if_throttled": False,
                "log_level": "info",
                "max_connections": 24,
                "metrics_granularity": "shard",
                "metrics_level": "detailed",
                "metrics_namespace": "KinesisProducerLibrary",
                "min_connections": 1,
                "port": 443,
                "rate_limit": 150,
                "record_max_buffered_time": 100,
                "record_ttl": 30000,
                "region": "${AWS_REGION}",
                "request_timeout": 6000,
                "verify_certificate": True
            },
            "description": "Kinesis Producer Library (KPL) configuration"
        }

    def generate_consumer_config(self, application_name: str) -> Dict[str, Any]:
        """Generate Kinesis consumer configuration."""
        return {
            "application_name": application_name,
            "config": {
                "initial_position_in_stream": "TRIM_HORIZON",
                "max_records": 10000,
                "idle_time_between_reads_in_millis": 1000,
                "call_process_records_even_for_empty_record_list": False,
                "parent_shard_poll_interval_millis": 10000,
                "shard_sync_interval_millis": 60000,
                "cleanup_leases_upon_shard_completion": True,
                "task_backoff_time_millis": 500,
                "metrics_buffer_time_millis": 10000,
                "metrics_max_queue_size": 10000,
                "validate_sequence_number_before_checkpointing": True,
                "region_name": "${AWS_REGION}"
            },
            "description": "Kinesis Client Library (KCL) configuration"
        }


class DockerComposeGenerator:
    """Generates Docker Compose files for streaming development."""

    def generate_kafka_stack(self, include_schema_registry: bool = True, include_connect: bool = False) -> str:
        """Generate Docker Compose for Kafka development stack."""
        compose = '''version: '3.8'

services:
  zookeeper:
    image: confluentinc/cp-zookeeper:7.5.0
    hostname: zookeeper
    container_name: zookeeper
    ports:
      - "2181:2181"
    environment:
      ZOOKEEPER_CLIENT_PORT: 2181
      ZOOKEEPER_TICK_TIME: 2000

  kafka:
    image: confluentinc/cp-kafka:7.5.0
    hostname: kafka
    container_name: kafka
    depends_on:
      - zookeeper
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
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: "true"
'''

        if include_schema_registry:
            compose += '''
  schema-registry:
    image: confluentinc/cp-schema-registry:7.5.0
    hostname: schema-registry
    container_name: schema-registry
    depends_on:
      - kafka
    ports:
      - "8081:8081"
    environment:
      SCHEMA_REGISTRY_HOST_NAME: schema-registry
      SCHEMA_REGISTRY_KAFKASTORE_BOOTSTRAP_SERVERS: kafka:29092
      SCHEMA_REGISTRY_LISTENERS: http://0.0.0.0:8081
'''

        if include_connect:
            compose += '''
  kafka-connect:
    image: confluentinc/cp-kafka-connect:7.5.0
    hostname: kafka-connect
    container_name: kafka-connect
    depends_on:
      - kafka
      - schema-registry
    ports:
      - "8083:8083"
    environment:
      CONNECT_BOOTSTRAP_SERVERS: kafka:29092
      CONNECT_REST_PORT: 8083
      CONNECT_GROUP_ID: kafka-connect
      CONNECT_CONFIG_STORAGE_TOPIC: _connect-configs
      CONNECT_OFFSET_STORAGE_TOPIC: _connect-offsets
      CONNECT_STATUS_STORAGE_TOPIC: _connect-status
      CONNECT_KEY_CONVERTER: io.confluent.connect.avro.AvroConverter
      CONNECT_KEY_CONVERTER_SCHEMA_REGISTRY_URL: http://schema-registry:8081
      CONNECT_VALUE_CONVERTER: io.confluent.connect.avro.AvroConverter
      CONNECT_VALUE_CONVERTER_SCHEMA_REGISTRY_URL: http://schema-registry:8081
      CONNECT_CONFIG_STORAGE_REPLICATION_FACTOR: 1
      CONNECT_OFFSET_STORAGE_REPLICATION_FACTOR: 1
      CONNECT_STATUS_STORAGE_REPLICATION_FACTOR: 1
'''

        compose += '''
  kafka-ui:
    image: provectuslabs/kafka-ui:latest
    container_name: kafka-ui
    depends_on:
      - kafka
    ports:
      - "8080:8080"
    environment:
      KAFKA_CLUSTERS_0_NAME: local
      KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS: kafka:29092
'''

        if include_schema_registry:
            compose += '''      KAFKA_CLUSTERS_0_SCHEMAREGISTRY: http://schema-registry:8081
'''

        if include_connect:
            compose += '''      KAFKA_CLUSTERS_0_KAFKACONNECT_0_NAME: connect
      KAFKA_CLUSTERS_0_KAFKACONNECT_0_ADDRESS: http://kafka-connect:8083
'''

        compose += '''
networks:
  default:
    name: streaming-network
'''

        return compose

    def generate_full_streaming_stack(self) -> str:
        """Generate Docker Compose for full streaming development stack."""
        compose = '''version: '3.8'

services:
  # Zookeeper
  zookeeper:
    image: confluentinc/cp-zookeeper:7.5.0
    hostname: zookeeper
    container_name: zookeeper
    ports:
      - "2181:2181"
    environment:
      ZOOKEEPER_CLIENT_PORT: 2181
      ZOOKEEPER_TICK_TIME: 2000

  # Kafka Broker
  kafka:
    image: confluentinc/cp-kafka:7.5.0
    hostname: kafka
    container_name: kafka
    depends_on:
      - zookeeper
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
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: "true"

  # Schema Registry
  schema-registry:
    image: confluentinc/cp-schema-registry:7.5.0
    hostname: schema-registry
    container_name: schema-registry
    depends_on:
      - kafka
    ports:
      - "8081:8081"
    environment:
      SCHEMA_REGISTRY_HOST_NAME: schema-registry
      SCHEMA_REGISTRY_KAFKASTORE_BOOTSTRAP_SERVERS: kafka:29092

  # Flink Job Manager
  flink-jobmanager:
    image: flink:1.18-scala_2.12
    hostname: flink-jobmanager
    container_name: flink-jobmanager
    ports:
      - "8082:8081"
    command: jobmanager
    environment:
      - |
        FLINK_PROPERTIES=
        jobmanager.rpc.address: flink-jobmanager
        state.backend: rocksdb
        state.checkpoints.dir: file:///tmp/flink-checkpoints
    volumes:
      - flink-checkpoints:/tmp/flink-checkpoints

  # Flink Task Manager
  flink-taskmanager:
    image: flink:1.18-scala_2.12
    hostname: flink-taskmanager
    depends_on:
      - flink-jobmanager
    command: taskmanager
    scale: 2
    environment:
      - |
        FLINK_PROPERTIES=
        jobmanager.rpc.address: flink-jobmanager
        taskmanager.numberOfTaskSlots: 4
        taskmanager.memory.process.size: 2048m
        state.backend: rocksdb
    volumes:
      - flink-checkpoints:/tmp/flink-checkpoints

  # Kafka UI
  kafka-ui:
    image: provectuslabs/kafka-ui:latest
    container_name: kafka-ui
    depends_on:
      - kafka
      - schema-registry
    ports:
      - "8080:8080"
    environment:
      KAFKA_CLUSTERS_0_NAME: local
      KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS: kafka:29092
      KAFKA_CLUSTERS_0_SCHEMAREGISTRY: http://schema-registry:8081

  # Redis (for caching/state)
  redis:
    image: redis:7-alpine
    hostname: redis
    container_name: redis
    ports:
      - "6379:6379"

  # PostgreSQL (for state/sink)
  postgres:
    image: postgres:15-alpine
    hostname: postgres
    container_name: postgres
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: streaming
      POSTGRES_PASSWORD: streaming
      POSTGRES_DB: streaming
    volumes:
      - postgres-data:/var/lib/postgresql/data

volumes:
  flink-checkpoints:
  postgres-data:

networks:
  default:
    name: streaming-network
'''
        return compose


class StreamProcessor:
    """Main stream processor class."""

    def __init__(self, verbose: bool = False):
        self.verbose = verbose
        self.validator = ConfigValidator()
        self.kafka_generator = KafkaConfigGenerator(verbose)
        self.flink_generator = FlinkJobGenerator(verbose)
        self.kinesis_generator = KinesisConfigGenerator(verbose)
        self.docker_generator = DockerComposeGenerator()

    def load_config(self, config_path: str) -> Dict[str, Any]:
        """Load configuration from file."""
        if not os.path.exists(config_path):
            raise FileNotFoundError(f"Configuration file not found: {config_path}")

        with open(config_path, 'r') as f:
            content = f.read()

        if config_path.endswith('.json'):
            return json.loads(content)
        else:
            return SimpleYamlParser.parse(content)

    def validate_config(self, config: Dict[str, Any]) -> ValidationResult:
        """Validate streaming configuration."""
        return self.validator.validate(config)

    def generate_pipeline(self, config: Dict[str, Any], output_dir: str) -> Dict[str, Any]:
        """Generate complete streaming pipeline artifacts."""
        os.makedirs(output_dir, exist_ok=True)

        results = {
            "output_dir": output_dir,
            "files_generated": [],
            "config": config
        }

        # Determine source type
        source_type = config.get('source', {}).get('type', 'kafka').lower()
        sink_type = config.get('sink', {}).get('type', 'kafka').lower()
        framework = config.get('processing', {}).get('framework', 'flink').lower()

        # Generate Kafka configurations if needed
        if source_type == 'kafka' or sink_type == 'kafka':
            kafka_config = self._generate_kafka_configs(config, output_dir)
            results['kafka'] = kafka_config
            results['files_generated'].extend(kafka_config.get('files', []))

        # Generate Flink job if framework is Flink
        if framework == 'flink':
            flink_config = self._generate_flink_job(config, output_dir)
            results['flink'] = flink_config
            results['files_generated'].extend(flink_config.get('files', []))

        # Generate Kinesis configurations if needed
        if source_type == 'kinesis':
            kinesis_config = self._generate_kinesis_configs(config, output_dir)
            results['kinesis'] = kinesis_config
            results['files_generated'].extend(kinesis_config.get('files', []))

        # Generate Docker Compose
        docker_compose = self._generate_docker_compose(config, output_dir)
        results['docker'] = docker_compose
        results['files_generated'].extend(docker_compose.get('files', []))

        return results

    def _generate_kafka_configs(self, config: Dict[str, Any], output_dir: str) -> Dict[str, Any]:
        """Generate Kafka configurations."""
        files = []

        # Generate topic configs
        source = config.get('source', {})
        sink = config.get('sink', {})

        topics_config = []

        if source.get('type') == 'kafka':
            topic = source.get('topic') or source.get('topics', ['input_topic'])[0]
            topic_config = self.kafka_generator.generate_topic_config(
                topic,
                partitions=source.get('partitions', 12),
                retention_days=source.get('retention_days', 7)
            )
            topics_config.append(topic_config)

        if sink.get('type') == 'kafka':
            topic = sink.get('topic', 'output_topic')
            topic_config = self.kafka_generator.generate_topic_config(
                topic,
                partitions=sink.get('partitions', 12),
                retention_days=sink.get('retention_days', 7)
            )
            topics_config.append(topic_config)

        # Write topic configs
        topics_file = os.path.join(output_dir, 'kafka-topics.json')
        with open(topics_file, 'w') as f:
            json.dump(topics_config, f, indent=2)
        files.append(topics_file)

        # Generate producer/consumer configs
        processing = config.get('processing', {})
        checkpoint = processing.get('checkpointing', {})
        mode = checkpoint.get('mode', 'at_least_once')

        profile = 'exactly_once' if mode == 'exactly_once' else 'default'

        producer_config = self.kafka_generator.generate_producer_config(profile)
        consumer_config = self.kafka_generator.generate_consumer_config(
            profile,
            source.get('consumer_group', f"{config.get('name', 'streaming')}_consumer")
        )

        clients_file = os.path.join(output_dir, 'kafka-clients.json')
        with open(clients_file, 'w') as f:
            json.dump({'producer': producer_config, 'consumer': consumer_config}, f, indent=2)
        files.append(clients_file)

        return {'topics': topics_config, 'clients': {'producer': producer_config, 'consumer': consumer_config}, 'files': files}

    def _generate_flink_job(self, config: Dict[str, Any], output_dir: str) -> Dict[str, Any]:
        """Generate Flink job artifacts."""
        files = []

        processing = config.get('processing', {})
        checkpoint = processing.get('checkpointing', {})

        job_config = self.flink_generator.generate_datastream_job(
            job_name=config.get('name', 'streaming_job'),
            source_type=config.get('source', {}).get('type', 'kafka'),
            sink_type=config.get('sink', {}).get('type', 'kafka'),
            parallelism=processing.get('parallelism', 4),
            checkpoint_interval=checkpoint.get('interval_ms', 60000),
            checkpoint_mode=checkpoint.get('mode', 'exactly_once')
        )

        # Write Python job
        python_file = os.path.join(output_dir, f"{config.get('name', 'streaming_job')}.py")
        with open(python_file, 'w') as f:
            f.write(job_config['python_code'])
        files.append(python_file)

        # Write Java job
        java_file = os.path.join(output_dir, f"{config.get('name', 'streaming_job').replace('-', '_').title()}.java")
        with open(java_file, 'w') as f:
            f.write(job_config['java_code'])
        files.append(java_file)

        # Write Flink Docker Compose
        flink_compose_file = os.path.join(output_dir, 'docker-compose-flink.yaml')
        with open(flink_compose_file, 'w') as f:
            f.write(job_config['docker_compose'])
        files.append(flink_compose_file)

        return {'job_config': job_config['configuration'], 'files': files}

    def _generate_kinesis_configs(self, config: Dict[str, Any], output_dir: str) -> Dict[str, Any]:
        """Generate Kinesis configurations."""
        files = []

        source = config.get('source', {})
        stream_name = source.get('stream') or source.get('stream_name', 'input_stream')

        stream_config = self.kinesis_generator.generate_stream_config(
            stream_name=stream_name,
            shard_count=source.get('shard_count', 4),
            retention_hours=source.get('retention_hours', 24)
        )

        kinesis_file = os.path.join(output_dir, 'kinesis-stream.json')
        with open(kinesis_file, 'w') as f:
            json.dump(stream_config, f, indent=2)
        files.append(kinesis_file)

        # Write Terraform
        terraform_file = os.path.join(output_dir, 'kinesis.tf')
        with open(terraform_file, 'w') as f:
            f.write(stream_config['terraform'])
        files.append(terraform_file)

        return {'stream_config': stream_config, 'files': files}

    def _generate_docker_compose(self, config: Dict[str, Any], output_dir: str) -> Dict[str, Any]:
        """Generate Docker Compose for development."""
        files = []

        compose = self.docker_generator.generate_full_streaming_stack()

        compose_file = os.path.join(output_dir, 'docker-compose.yaml')
        with open(compose_file, 'w') as f:
            f.write(compose)
        files.append(compose_file)

        return {'files': files}

    def generate_kafka_topic(
        self,
        topics: List[str],
        partitions: int = 12,
        replication_factor: int = 3,
        retention_days: int = 7
    ) -> List[Dict[str, Any]]:
        """Generate Kafka topic configurations."""
        configs = []
        for topic in topics:
            config = self.kafka_generator.generate_topic_config(
                topic,
                partitions=partitions,
                replication_factor=replication_factor,
                retention_days=retention_days
            )
            configs.append(config)
        return configs

    def generate_flink_job(
        self,
        job_name: str,
        source_type: str = "kafka",
        sink_type: str = "kafka",
        parallelism: int = 4
    ) -> Dict[str, Any]:
        """Generate Flink job skeleton."""
        return self.flink_generator.generate_datastream_job(
            job_name=job_name,
            source_type=source_type,
            sink_type=sink_type,
            parallelism=parallelism
        )

    def generate_kinesis_stream(
        self,
        stream_name: str,
        shards: int = 4,
        retention_hours: int = 24
    ) -> Dict[str, Any]:
        """Generate Kinesis stream configuration."""
        return self.kinesis_generator.generate_stream_config(
            stream_name=stream_name,
            shard_count=shards,
            retention_hours=retention_hours
        )


def format_output(data: Any, format_type: str = "text") -> str:
    """Format output based on specified format."""
    if format_type == "json":
        return json.dumps(data, indent=2, default=str)

    # Text format
    if isinstance(data, dict):
        lines = []
        for key, value in data.items():
            if isinstance(value, dict):
                lines.append(f"\n{key}:")
                for k, v in value.items():
                    lines.append(f"  {k}: {v}")
            elif isinstance(value, list):
                lines.append(f"\n{key}:")
                for item in value:
                    if isinstance(item, dict):
                        lines.append(f"  - {item}")
                    else:
                        lines.append(f"  - {item}")
            else:
                lines.append(f"{key}: {value}")
        return '\n'.join(lines)

    return str(data)


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Stream Processor - Streaming Pipeline Configuration Generator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Validate streaming configuration
  python stream_processor.py --config streaming_config.yaml --validate

  # Generate Kafka topic configuration
  python stream_processor.py --mode kafka --topics orders,users --partitions 12

  # Generate Flink job skeleton
  python stream_processor.py --mode flink --job-name order_processor

  # Generate Kinesis stream configuration
  python stream_processor.py --mode kinesis --stream orders --shards 4

  # Generate full streaming pipeline
  python stream_processor.py --config streaming_config.yaml --generate --output-dir ./generated
        """
    )

    parser.add_argument('--version', action='version', version=f'%(prog)s {__version__}')
    parser.add_argument('--config', '-c', help='Path to streaming configuration file (YAML or JSON)')
    parser.add_argument('--validate', action='store_true', help='Validate configuration only')
    parser.add_argument('--generate', action='store_true', help='Generate pipeline artifacts')
    parser.add_argument('--output-dir', '-o', default='./streaming-output', help='Output directory for generated files')
    parser.add_argument('--output', choices=['text', 'json'], default='text', help='Output format')
    parser.add_argument('--verbose', '-v', action='store_true', help='Verbose output')

    # Mode-specific options
    parser.add_argument('--mode', choices=['kafka', 'flink', 'kinesis', 'docker'], help='Generation mode')

    # Kafka options
    parser.add_argument('--topics', help='Comma-separated list of Kafka topics')
    parser.add_argument('--partitions', type=int, default=12, help='Number of partitions (default: 12)')
    parser.add_argument('--replication-factor', type=int, default=3, help='Replication factor (default: 3)')
    parser.add_argument('--retention-days', type=int, default=7, help='Retention period in days (default: 7)')

    # Flink options
    parser.add_argument('--job-name', help='Flink job name')
    parser.add_argument('--parallelism', type=int, default=4, help='Flink parallelism (default: 4)')
    parser.add_argument('--input', choices=['kafka', 'kinesis', 'file'], default='kafka', help='Input source type')

    # Kinesis options
    parser.add_argument('--stream', help='Kinesis stream name')
    parser.add_argument('--shards', type=int, default=4, help='Number of shards (default: 4)')

    args = parser.parse_args()

    processor = StreamProcessor(verbose=args.verbose)

    try:
        # Handle config-based operations
        if args.config:
            config = processor.load_config(args.config)

            if args.validate:
                result = processor.validate_config(config)

                output = {
                    "status": "valid" if result.is_valid else "invalid",
                    "errors": result.errors,
                    "warnings": result.warnings,
                    "info": result.info
                }

                print(format_output(output, args.output))
                sys.exit(0 if result.is_valid else 1)

            if args.generate:
                result = processor.generate_pipeline(config, args.output_dir)

                output = {
                    "status": "success",
                    "output_dir": result['output_dir'],
                    "files_generated": result['files_generated']
                }

                print(format_output(output, args.output))
                sys.exit(0)

        # Handle mode-based operations
        if args.mode == 'kafka':
            if not args.topics:
                print("Error: --topics required for kafka mode", file=sys.stderr)
                sys.exit(1)

            topics = [t.strip() for t in args.topics.split(',')]
            result = processor.generate_kafka_topic(
                topics,
                partitions=args.partitions,
                replication_factor=args.replication_factor,
                retention_days=args.retention_days
            )
            print(format_output(result, args.output))

        elif args.mode == 'flink':
            if not args.job_name:
                print("Error: --job-name required for flink mode", file=sys.stderr)
                sys.exit(1)

            result = processor.generate_flink_job(
                args.job_name,
                source_type=args.input,
                parallelism=args.parallelism
            )
            print(format_output(result, args.output))

        elif args.mode == 'kinesis':
            if not args.stream:
                print("Error: --stream required for kinesis mode", file=sys.stderr)
                sys.exit(1)

            result = processor.generate_kinesis_stream(
                args.stream,
                shards=args.shards,
                retention_hours=args.retention_days * 24
            )
            print(format_output(result, args.output))

        elif args.mode == 'docker':
            generator = DockerComposeGenerator()
            result = generator.generate_full_streaming_stack()
            print(result)

        else:
            parser.print_help()

    except FileNotFoundError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"Error parsing JSON: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        if args.verbose:
            import traceback
            traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
