#!/usr/bin/env python3
"""
Kafka Config Generator - Production-Ready Kafka Configuration Tool

A comprehensive tool for generating Apache Kafka configurations with best practices
for topics, producers, consumers, and Kafka Streams applications. Includes security
configuration, performance tuning profiles, and deployment templates.

Features:
- Topic configuration generator (retention, partitions, replication)
- Producer configuration profiles (high-throughput, exactly-once, low-latency)
- Consumer configuration profiles (exactly-once, batch, streaming)
- Kafka Streams application configuration
- Kafka Connect connector configuration
- Security configuration (SASL, SSL, ACLs)
- Performance tuning recommendations
- Output formats: properties, YAML, JSON

Usage:
    # Generate topic configuration
    python kafka_config_generator.py --mode topic --name orders --partitions 12 --retention-days 7

    # Generate producer configuration for high throughput
    python kafka_config_generator.py --mode producer --profile high-throughput --output properties

    # Generate consumer configuration
    python kafka_config_generator.py --mode consumer --group order_processor --profile exactly-once

    # Generate Kafka Streams config
    python kafka_config_generator.py --mode streams --app-id order_aggregator --output yaml

    # Generate full cluster configuration
    python kafka_config_generator.py --mode cluster --brokers 3 --output-dir ./kafka-config

    # Security configuration
    python kafka_config_generator.py --mode security --auth sasl-scram --ssl enabled

Author: Claude Skills Team
Version: 1.0.0
"""

import argparse
import json
import os
import sys
from datetime import datetime
from typing import Dict, List, Any, Optional
from dataclasses import dataclass, field
from enum import Enum

__version__ = "1.0.0"


class AuthType(Enum):
    """Authentication types."""
    NONE = "none"
    SASL_PLAIN = "sasl-plain"
    SASL_SCRAM = "sasl-scram"
    SASL_OAUTHBEARER = "sasl-oauthbearer"
    MTLS = "mtls"


class ProducerProfile(Enum):
    """Producer configuration profiles."""
    DEFAULT = "default"
    HIGH_THROUGHPUT = "high-throughput"
    EXACTLY_ONCE = "exactly-once"
    LOW_LATENCY = "low-latency"
    ORDERED = "ordered"


class ConsumerProfile(Enum):
    """Consumer configuration profiles."""
    DEFAULT = "default"
    EXACTLY_ONCE = "exactly-once"
    HIGH_THROUGHPUT = "high-throughput"
    LOW_LATENCY = "low-latency"
    BATCH = "batch"


class OutputFormat(Enum):
    """Output format types."""
    PROPERTIES = "properties"
    YAML = "yaml"
    JSON = "json"


@dataclass
class TopicConfig:
    """Topic configuration."""
    name: str
    partitions: int = 12
    replication_factor: int = 3
    retention_ms: int = 604800000  # 7 days
    retention_bytes: int = -1
    cleanup_policy: str = "delete"
    compression_type: str = "lz4"
    min_insync_replicas: int = 2
    segment_bytes: int = 1073741824  # 1GB
    segment_ms: int = 86400000  # 1 day
    max_message_bytes: int = 1048576  # 1MB


@dataclass
class ProducerConfig:
    """Producer configuration."""
    acks: str = "all"
    retries: int = 3
    batch_size: int = 16384
    linger_ms: int = 5
    buffer_memory: int = 33554432
    compression_type: str = "lz4"
    enable_idempotence: bool = False
    max_in_flight_requests: int = 5
    transactional_id: Optional[str] = None
    request_timeout_ms: int = 30000
    delivery_timeout_ms: int = 120000


@dataclass
class ConsumerConfig:
    """Consumer configuration."""
    group_id: str
    auto_offset_reset: str = "earliest"
    enable_auto_commit: bool = True
    auto_commit_interval_ms: int = 5000
    fetch_min_bytes: int = 1
    fetch_max_wait_ms: int = 500
    max_poll_records: int = 500
    session_timeout_ms: int = 30000
    heartbeat_interval_ms: int = 10000
    isolation_level: str = "read_uncommitted"
    max_partition_fetch_bytes: int = 1048576


class KafkaConfigGenerator:
    """Main Kafka configuration generator."""

    # Producer profiles
    PRODUCER_PROFILES = {
        ProducerProfile.DEFAULT: {
            "acks": "all",
            "retries": 3,
            "batch.size": 16384,
            "linger.ms": 5,
            "buffer.memory": 33554432,
            "compression.type": "lz4",
            "enable.idempotence": False,
            "max.in.flight.requests.per.connection": 5,
            "request.timeout.ms": 30000,
            "delivery.timeout.ms": 120000,
            "metadata.max.age.ms": 300000,
            "reconnect.backoff.ms": 50,
            "reconnect.backoff.max.ms": 1000
        },
        ProducerProfile.HIGH_THROUGHPUT: {
            "acks": "1",
            "retries": 3,
            "batch.size": 65536,
            "linger.ms": 20,
            "buffer.memory": 67108864,
            "compression.type": "lz4",
            "enable.idempotence": False,
            "max.in.flight.requests.per.connection": 10,
            "request.timeout.ms": 30000,
            "delivery.timeout.ms": 120000,
            "send.buffer.bytes": 131072,
            "metadata.max.age.ms": 300000
        },
        ProducerProfile.EXACTLY_ONCE: {
            "acks": "all",
            "retries": 2147483647,
            "batch.size": 16384,
            "linger.ms": 5,
            "buffer.memory": 33554432,
            "compression.type": "lz4",
            "enable.idempotence": True,
            "max.in.flight.requests.per.connection": 5,
            "transactional.id": "${TRANSACTIONAL_ID}",
            "transaction.timeout.ms": 60000,
            "request.timeout.ms": 30000,
            "delivery.timeout.ms": 120000
        },
        ProducerProfile.LOW_LATENCY: {
            "acks": "1",
            "retries": 0,
            "batch.size": 0,
            "linger.ms": 0,
            "buffer.memory": 33554432,
            "compression.type": "none",
            "enable.idempotence": False,
            "max.in.flight.requests.per.connection": 1,
            "request.timeout.ms": 10000,
            "delivery.timeout.ms": 15000,
            "send.buffer.bytes": 65536
        },
        ProducerProfile.ORDERED: {
            "acks": "all",
            "retries": 2147483647,
            "batch.size": 16384,
            "linger.ms": 5,
            "buffer.memory": 33554432,
            "compression.type": "lz4",
            "enable.idempotence": True,
            "max.in.flight.requests.per.connection": 1,
            "request.timeout.ms": 30000,
            "delivery.timeout.ms": 120000
        }
    }

    # Consumer profiles
    CONSUMER_PROFILES = {
        ConsumerProfile.DEFAULT: {
            "auto.offset.reset": "earliest",
            "enable.auto.commit": True,
            "auto.commit.interval.ms": 5000,
            "fetch.min.bytes": 1,
            "fetch.max.wait.ms": 500,
            "max.poll.records": 500,
            "session.timeout.ms": 30000,
            "heartbeat.interval.ms": 10000,
            "max.partition.fetch.bytes": 1048576,
            "isolation.level": "read_uncommitted",
            "reconnect.backoff.ms": 50,
            "reconnect.backoff.max.ms": 1000
        },
        ConsumerProfile.EXACTLY_ONCE: {
            "auto.offset.reset": "earliest",
            "enable.auto.commit": False,
            "fetch.min.bytes": 1,
            "fetch.max.wait.ms": 500,
            "max.poll.records": 500,
            "session.timeout.ms": 30000,
            "heartbeat.interval.ms": 10000,
            "max.partition.fetch.bytes": 1048576,
            "isolation.level": "read_committed"
        },
        ConsumerProfile.HIGH_THROUGHPUT: {
            "auto.offset.reset": "earliest",
            "enable.auto.commit": True,
            "auto.commit.interval.ms": 5000,
            "fetch.min.bytes": 50000,
            "fetch.max.wait.ms": 500,
            "max.poll.records": 1000,
            "session.timeout.ms": 30000,
            "heartbeat.interval.ms": 10000,
            "max.partition.fetch.bytes": 2097152,
            "isolation.level": "read_uncommitted",
            "receive.buffer.bytes": 131072
        },
        ConsumerProfile.LOW_LATENCY: {
            "auto.offset.reset": "latest",
            "enable.auto.commit": True,
            "auto.commit.interval.ms": 1000,
            "fetch.min.bytes": 1,
            "fetch.max.wait.ms": 100,
            "max.poll.records": 100,
            "session.timeout.ms": 10000,
            "heartbeat.interval.ms": 3000,
            "max.partition.fetch.bytes": 524288,
            "isolation.level": "read_uncommitted"
        },
        ConsumerProfile.BATCH: {
            "auto.offset.reset": "earliest",
            "enable.auto.commit": False,
            "fetch.min.bytes": 100000,
            "fetch.max.wait.ms": 1000,
            "max.poll.records": 2000,
            "session.timeout.ms": 60000,
            "heartbeat.interval.ms": 20000,
            "max.partition.fetch.bytes": 4194304,
            "isolation.level": "read_uncommitted"
        }
    }

    def __init__(self, verbose: bool = False):
        self.verbose = verbose

    def generate_topic_config(
        self,
        name: str,
        partitions: int = 12,
        replication_factor: int = 3,
        retention_days: int = 7,
        cleanup_policy: str = "delete",
        compression: str = "lz4",
        compact_retention_ms: int = None
    ) -> Dict[str, Any]:
        """Generate topic configuration."""
        retention_ms = retention_days * 86400000

        config = {
            "topic_name": name,
            "partitions": partitions,
            "replication_factor": replication_factor,
            "configs": {
                "retention.ms": str(retention_ms),
                "retention.bytes": "-1",
                "cleanup.policy": cleanup_policy,
                "compression.type": compression,
                "min.insync.replicas": str(min(2, replication_factor)),
                "segment.bytes": "1073741824",
                "segment.ms": "86400000",
                "max.message.bytes": "1048576",
                "unclean.leader.election.enable": "false",
                "message.timestamp.type": "CreateTime"
            }
        }

        # Add compaction settings if policy includes compact
        if "compact" in cleanup_policy:
            config["configs"]["min.cleanable.dirty.ratio"] = "0.5"
            config["configs"]["delete.retention.ms"] = str(compact_retention_ms or 86400000)
            config["configs"]["min.compaction.lag.ms"] = "0"
            config["configs"]["max.compaction.lag.ms"] = "9223372036854775807"

        # Generate CLI command
        config["cli_command"] = self._generate_topic_cli(name, partitions, replication_factor, config["configs"])

        # Generate Terraform
        config["terraform"] = self._generate_topic_terraform(name, partitions, replication_factor, config["configs"])

        return config

    def _generate_topic_cli(
        self,
        name: str,
        partitions: int,
        replication_factor: int,
        configs: Dict[str, str]
    ) -> str:
        """Generate kafka-topics CLI command."""
        cmd_lines = [
            "kafka-topics.sh --create \\",
            f"  --topic {name} \\",
            f"  --partitions {partitions} \\",
            f"  --replication-factor {replication_factor} \\"
        ]

        for key, value in configs.items():
            cmd_lines.append(f"  --config {key}={value} \\")

        cmd_lines.append("  --bootstrap-server $KAFKA_BOOTSTRAP_SERVERS")

        return '\n'.join(cmd_lines)

    def _generate_topic_terraform(
        self,
        name: str,
        partitions: int,
        replication_factor: int,
        configs: Dict[str, str]
    ) -> str:
        """Generate Terraform configuration for topic."""
        tf_name = name.replace("-", "_").replace(".", "_")

        config_lines = []
        for key, value in configs.items():
            tf_key = key.replace(".", "_")
            config_lines.append(f'    {key} = "{value}"')

        terraform = f'''resource "kafka_topic" "{tf_name}" {{
  name               = "{name}"
  partitions         = {partitions}
  replication_factor = {replication_factor}

  config = {{
{chr(10).join(config_lines)}
  }}
}}'''
        return terraform

    def generate_producer_config(
        self,
        profile: str = "default",
        bootstrap_servers: str = None,
        transactional_id: str = None
    ) -> Dict[str, Any]:
        """Generate producer configuration."""
        try:
            profile_enum = ProducerProfile(profile)
        except ValueError:
            profile_enum = ProducerProfile.DEFAULT

        config = dict(self.PRODUCER_PROFILES[profile_enum])

        if bootstrap_servers:
            config["bootstrap.servers"] = bootstrap_servers

        if transactional_id and profile_enum == ProducerProfile.EXACTLY_ONCE:
            config["transactional.id"] = transactional_id

        return {
            "profile": profile,
            "description": self._get_producer_profile_description(profile_enum),
            "use_case": self._get_producer_profile_use_case(profile_enum),
            "config": config,
            "properties": self._dict_to_properties(config),
            "java_properties": self._dict_to_java_properties(config, "producer"),
            "python_config": self._dict_to_python_config(config)
        }

    def _get_producer_profile_description(self, profile: ProducerProfile) -> str:
        """Get producer profile description."""
        descriptions = {
            ProducerProfile.DEFAULT: "Balanced configuration for general use with durability guarantees",
            ProducerProfile.HIGH_THROUGHPUT: "Optimized for maximum throughput with larger batches and compression",
            ProducerProfile.EXACTLY_ONCE: "Ensures exactly-once semantics with idempotent and transactional producers",
            ProducerProfile.LOW_LATENCY: "Minimizes latency at the cost of throughput and durability",
            ProducerProfile.ORDERED: "Guarantees strict message ordering with idempotent producers"
        }
        return descriptions.get(profile, "Custom configuration")

    def _get_producer_profile_use_case(self, profile: ProducerProfile) -> str:
        """Get producer profile use case."""
        use_cases = {
            ProducerProfile.DEFAULT: "General event streaming, logging, metrics collection",
            ProducerProfile.HIGH_THROUGHPUT: "Log aggregation, clickstream processing, IoT sensor data",
            ProducerProfile.EXACTLY_ONCE: "Financial transactions, order processing, inventory updates",
            ProducerProfile.LOW_LATENCY: "Real-time gaming, live dashboards, alerting systems",
            ProducerProfile.ORDERED: "Event sourcing, audit logs, state machines"
        }
        return use_cases.get(profile, "Custom use case")

    def generate_consumer_config(
        self,
        group_id: str,
        profile: str = "default",
        bootstrap_servers: str = None
    ) -> Dict[str, Any]:
        """Generate consumer configuration."""
        try:
            profile_enum = ConsumerProfile(profile)
        except ValueError:
            profile_enum = ConsumerProfile.DEFAULT

        config = dict(self.CONSUMER_PROFILES[profile_enum])
        config["group.id"] = group_id

        if bootstrap_servers:
            config["bootstrap.servers"] = bootstrap_servers

        return {
            "profile": profile,
            "group_id": group_id,
            "description": self._get_consumer_profile_description(profile_enum),
            "use_case": self._get_consumer_profile_use_case(profile_enum),
            "config": config,
            "properties": self._dict_to_properties(config),
            "java_properties": self._dict_to_java_properties(config, "consumer"),
            "python_config": self._dict_to_python_config(config)
        }

    def _get_consumer_profile_description(self, profile: ConsumerProfile) -> str:
        """Get consumer profile description."""
        descriptions = {
            ConsumerProfile.DEFAULT: "Balanced configuration for general consumption patterns",
            ConsumerProfile.EXACTLY_ONCE: "Ensures exactly-once processing with manual offset commits",
            ConsumerProfile.HIGH_THROUGHPUT: "Optimized for high-volume consumption with large batches",
            ConsumerProfile.LOW_LATENCY: "Minimizes processing latency with small batches and fast polling",
            ConsumerProfile.BATCH: "Optimized for batch processing with large record fetches"
        }
        return descriptions.get(profile, "Custom configuration")

    def _get_consumer_profile_use_case(self, profile: ConsumerProfile) -> str:
        """Get consumer profile use case."""
        use_cases = {
            ConsumerProfile.DEFAULT: "Stream processing, real-time analytics, event handling",
            ConsumerProfile.EXACTLY_ONCE: "Financial processing, inventory management, order fulfillment",
            ConsumerProfile.HIGH_THROUGHPUT: "Data pipeline ingestion, log processing, ETL jobs",
            ConsumerProfile.LOW_LATENCY: "Real-time dashboards, alerting, live updates",
            ConsumerProfile.BATCH: "Periodic batch jobs, data warehouse loading, offline analytics"
        }
        return use_cases.get(profile, "Custom use case")

    def generate_streams_config(
        self,
        application_id: str,
        bootstrap_servers: str = None,
        state_dir: str = None,
        processing_guarantee: str = "exactly_once_v2"
    ) -> Dict[str, Any]:
        """Generate Kafka Streams configuration."""
        config = {
            "application.id": application_id,
            "processing.guarantee": processing_guarantee,
            "replication.factor": 3,
            "num.stream.threads": 4,
            "num.standby.replicas": 1,
            "state.dir": state_dir or "/tmp/kafka-streams",
            "cache.max.bytes.buffering": 10485760,  # 10MB
            "commit.interval.ms": 1000 if processing_guarantee == "at_least_once" else 100,
            "default.key.serde": "org.apache.kafka.common.serialization.Serdes$StringSerde",
            "default.value.serde": "org.apache.kafka.common.serialization.Serdes$StringSerde",
            "default.timestamp.extractor": "org.apache.kafka.streams.processor.WallclockTimestampExtractor",
            "max.task.idle.ms": 0,
            "buffered.records.per.partition": 1000,
            "poll.ms": 100,
            "metadata.max.age.ms": 60000,
            "topology.optimization": "all"
        }

        if bootstrap_servers:
            config["bootstrap.servers"] = bootstrap_servers

        # Add exactly-once specific configs
        if "exactly_once" in processing_guarantee:
            config["transaction.timeout.ms"] = 60000

        return {
            "application_id": application_id,
            "processing_guarantee": processing_guarantee,
            "description": "Kafka Streams application configuration with state management",
            "config": config,
            "properties": self._dict_to_properties(config),
            "java_properties": self._dict_to_java_properties(config, "streams")
        }

    def generate_connect_config(
        self,
        connector_name: str,
        connector_type: str = "source",
        connector_class: str = None,
        tasks_max: int = 1
    ) -> Dict[str, Any]:
        """Generate Kafka Connect configuration."""
        # Worker configuration
        worker_config = {
            "bootstrap.servers": "${KAFKA_BOOTSTRAP_SERVERS}",
            "group.id": f"connect-cluster-{connector_name}",
            "key.converter": "io.confluent.connect.avro.AvroConverter",
            "value.converter": "io.confluent.connect.avro.AvroConverter",
            "key.converter.schema.registry.url": "${SCHEMA_REGISTRY_URL}",
            "value.converter.schema.registry.url": "${SCHEMA_REGISTRY_URL}",
            "offset.storage.topic": f"connect-offsets-{connector_name}",
            "config.storage.topic": f"connect-configs-{connector_name}",
            "status.storage.topic": f"connect-status-{connector_name}",
            "offset.storage.replication.factor": 3,
            "config.storage.replication.factor": 3,
            "status.storage.replication.factor": 3,
            "offset.flush.interval.ms": 10000,
            "plugin.path": "/usr/share/java,/usr/share/confluent-hub-components"
        }

        # Connector configuration template
        connector_config = {
            "name": connector_name,
            "connector.class": connector_class or f"io.confluent.connect.{connector_type}.{connector_type.capitalize()}Connector",
            "tasks.max": tasks_max,
            "key.converter": "io.confluent.connect.avro.AvroConverter",
            "value.converter": "io.confluent.connect.avro.AvroConverter"
        }

        # Add type-specific configs
        if connector_type == "source":
            connector_config.update({
                "topic.prefix": f"{connector_name}_",
                "poll.interval.ms": 1000
            })
        elif connector_type == "sink":
            connector_config.update({
                "topics": "${TOPICS}",
                "flush.size": 1000
            })

        return {
            "connector_name": connector_name,
            "connector_type": connector_type,
            "worker_config": worker_config,
            "connector_config": connector_config,
            "worker_properties": self._dict_to_properties(worker_config),
            "connector_json": json.dumps(connector_config, indent=2)
        }

    def generate_security_config(
        self,
        auth_type: str = "none",
        ssl_enabled: bool = False,
        principal: str = None
    ) -> Dict[str, Any]:
        """Generate security configuration."""
        try:
            auth_enum = AuthType(auth_type)
        except ValueError:
            auth_enum = AuthType.NONE

        config = {}
        acls = []

        # SSL configuration
        if ssl_enabled:
            config.update({
                "security.protocol": "SSL" if auth_enum == AuthType.NONE else "SASL_SSL",
                "ssl.truststore.location": "/path/to/truststore.jks",
                "ssl.truststore.password": "${SSL_TRUSTSTORE_PASSWORD}",
                "ssl.keystore.location": "/path/to/keystore.jks",
                "ssl.keystore.password": "${SSL_KEYSTORE_PASSWORD}",
                "ssl.key.password": "${SSL_KEY_PASSWORD}",
                "ssl.endpoint.identification.algorithm": "https"
            })
        else:
            if auth_enum != AuthType.NONE:
                config["security.protocol"] = "SASL_PLAINTEXT"

        # SASL configuration
        if auth_enum == AuthType.SASL_PLAIN:
            config.update({
                "sasl.mechanism": "PLAIN",
                "sasl.jaas.config": 'org.apache.kafka.common.security.plain.PlainLoginModule required username="${KAFKA_USERNAME}" password="${KAFKA_PASSWORD}";'
            })
        elif auth_enum == AuthType.SASL_SCRAM:
            config.update({
                "sasl.mechanism": "SCRAM-SHA-256",
                "sasl.jaas.config": 'org.apache.kafka.common.security.scram.ScramLoginModule required username="${KAFKA_USERNAME}" password="${KAFKA_PASSWORD}";'
            })
        elif auth_enum == AuthType.SASL_OAUTHBEARER:
            config.update({
                "sasl.mechanism": "OAUTHBEARER",
                "sasl.oauthbearer.token.endpoint.url": "${OAUTH_TOKEN_ENDPOINT}",
                "sasl.login.callback.handler.class": "org.apache.kafka.common.security.oauthbearer.OAuthBearerLoginCallbackHandler"
            })
        elif auth_enum == AuthType.MTLS:
            config.update({
                "security.protocol": "SSL",
                "ssl.client.auth": "required"
            })

        # ACL templates
        if principal:
            acls = [
                {
                    "principal": f"User:{principal}",
                    "operation": "READ",
                    "resource_type": "TOPIC",
                    "resource_name": "*",
                    "pattern_type": "LITERAL"
                },
                {
                    "principal": f"User:{principal}",
                    "operation": "WRITE",
                    "resource_type": "TOPIC",
                    "resource_name": "*",
                    "pattern_type": "LITERAL"
                },
                {
                    "principal": f"User:{principal}",
                    "operation": "READ",
                    "resource_type": "GROUP",
                    "resource_name": "*",
                    "pattern_type": "PREFIXED"
                }
            ]

        return {
            "auth_type": auth_type,
            "ssl_enabled": ssl_enabled,
            "config": config,
            "properties": self._dict_to_properties(config),
            "acls": acls,
            "acl_commands": self._generate_acl_commands(acls) if acls else None
        }

    def _generate_acl_commands(self, acls: List[Dict[str, str]]) -> str:
        """Generate ACL CLI commands."""
        commands = []
        for acl in acls:
            cmd = f"""kafka-acls.sh --add \\
  --allow-principal "{acl['principal']}" \\
  --operation {acl['operation']} \\
  --{acl['resource_type'].lower()} {acl['resource_name']} \\
  --resource-pattern-type {acl['pattern_type']} \\
  --bootstrap-server $KAFKA_BOOTSTRAP_SERVERS"""
            commands.append(cmd)
        return '\n\n'.join(commands)

    def generate_cluster_config(
        self,
        broker_count: int = 3,
        zookeeper_count: int = 3,
        environment: str = "production"
    ) -> Dict[str, Any]:
        """Generate cluster configuration."""
        # Broker configuration
        broker_config = {
            "broker.id": "${BROKER_ID}",
            "listeners": "PLAINTEXT://:9092,SSL://:9093",
            "advertised.listeners": "PLAINTEXT://${HOSTNAME}:9092,SSL://${HOSTNAME}:9093",
            "num.network.threads": 8,
            "num.io.threads": 16,
            "socket.send.buffer.bytes": 102400,
            "socket.receive.buffer.bytes": 102400,
            "socket.request.max.bytes": 104857600,
            "log.dirs": "/var/kafka/data",
            "num.partitions": 12,
            "default.replication.factor": min(3, broker_count),
            "min.insync.replicas": max(1, min(2, broker_count - 1)),
            "num.recovery.threads.per.data.dir": 4,
            "offsets.topic.replication.factor": min(3, broker_count),
            "transaction.state.log.replication.factor": min(3, broker_count),
            "transaction.state.log.min.isr": max(1, min(2, broker_count - 1)),
            "log.retention.hours": 168,
            "log.retention.bytes": -1,
            "log.segment.bytes": 1073741824,
            "log.retention.check.interval.ms": 300000,
            "zookeeper.connect": ",".join([f"zk{i}:2181" for i in range(1, zookeeper_count + 1)]),
            "zookeeper.connection.timeout.ms": 18000,
            "group.initial.rebalance.delay.ms": 3000,
            "auto.create.topics.enable": "false",
            "delete.topic.enable": "true",
            "unclean.leader.election.enable": "false"
        }

        # Production-specific tuning
        if environment == "production":
            broker_config.update({
                "log.flush.interval.messages": 10000,
                "log.flush.interval.ms": 1000,
                "replica.lag.time.max.ms": 30000,
                "replica.fetch.max.bytes": 10485760,
                "message.max.bytes": 10485760
            })

        # Zookeeper configuration
        zk_config = {
            "tickTime": 2000,
            "initLimit": 10,
            "syncLimit": 5,
            "dataDir": "/var/zookeeper/data",
            "dataLogDir": "/var/zookeeper/log",
            "clientPort": 2181,
            "maxClientCnxns": 60,
            "autopurge.snapRetainCount": 3,
            "autopurge.purgeInterval": 24
        }

        # Generate Docker Compose
        docker_compose = self._generate_cluster_docker_compose(broker_count, zookeeper_count)

        return {
            "broker_count": broker_count,
            "zookeeper_count": zookeeper_count,
            "environment": environment,
            "broker_config": broker_config,
            "zookeeper_config": zk_config,
            "broker_properties": self._dict_to_properties(broker_config),
            "zookeeper_properties": self._dict_to_properties(zk_config),
            "docker_compose": docker_compose
        }

    def _generate_cluster_docker_compose(self, broker_count: int, zk_count: int) -> str:
        """Generate Docker Compose for Kafka cluster."""
        compose = "version: '3.8'\n\nservices:\n"

        # Zookeeper nodes
        for i in range(1, zk_count + 1):
            compose += f"""
  zk{i}:
    image: confluentinc/cp-zookeeper:7.5.0
    hostname: zk{i}
    container_name: zk{i}
    ports:
      - "{2180 + i}:2181"
    environment:
      ZOOKEEPER_SERVER_ID: {i}
      ZOOKEEPER_CLIENT_PORT: 2181
      ZOOKEEPER_TICK_TIME: 2000
      ZOOKEEPER_INIT_LIMIT: 5
      ZOOKEEPER_SYNC_LIMIT: 2
      ZOOKEEPER_SERVERS: {';'.join([f'zk{j}:2888:3888' for j in range(1, zk_count + 1)])}
    volumes:
      - zk{i}-data:/var/lib/zookeeper/data
      - zk{i}-log:/var/lib/zookeeper/log
"""

        # Kafka brokers
        zk_connect = ','.join([f'zk{i}:2181' for i in range(1, zk_count + 1)])
        for i in range(1, broker_count + 1):
            compose += f"""
  kafka{i}:
    image: confluentinc/cp-kafka:7.5.0
    hostname: kafka{i}
    container_name: kafka{i}
    depends_on:
{chr(10).join([f'      - zk{j}' for j in range(1, zk_count + 1)])}
    ports:
      - "{9091 + i}:9092"
    environment:
      KAFKA_BROKER_ID: {i}
      KAFKA_ZOOKEEPER_CONNECT: {zk_connect}
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,PLAINTEXT_HOST:PLAINTEXT
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka{i}:29092,PLAINTEXT_HOST://localhost:{9091 + i}
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: {min(3, broker_count)}
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: {max(1, min(2, broker_count - 1))}
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: {min(3, broker_count)}
      KAFKA_DEFAULT_REPLICATION_FACTOR: {min(3, broker_count)}
      KAFKA_MIN_INSYNC_REPLICAS: {max(1, min(2, broker_count - 1))}
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: "false"
    volumes:
      - kafka{i}-data:/var/lib/kafka/data
"""

        # Volumes
        compose += "\nvolumes:\n"
        for i in range(1, zk_count + 1):
            compose += f"  zk{i}-data:\n  zk{i}-log:\n"
        for i in range(1, broker_count + 1):
            compose += f"  kafka{i}-data:\n"

        return compose

    def _dict_to_properties(self, config: Dict[str, Any]) -> str:
        """Convert dictionary to properties format."""
        lines = []
        for key, value in config.items():
            lines.append(f"{key}={value}")
        return '\n'.join(lines)

    def _dict_to_java_properties(self, config: Dict[str, Any], client_type: str) -> str:
        """Generate Java Properties code."""
        lines = [f"Properties {client_type}Props = new Properties();"]
        for key, value in config.items():
            if isinstance(value, bool):
                value = str(value).lower()
            lines.append(f'{client_type}Props.put("{key}", "{value}");')
        return '\n'.join(lines)

    def _dict_to_python_config(self, config: Dict[str, Any]) -> str:
        """Generate Python configuration dictionary."""
        lines = ["config = {"]
        for key, value in config.items():
            py_key = key.replace(".", "_")
            if isinstance(value, bool):
                lines.append(f'    "{key}": {value},')
            elif isinstance(value, int):
                lines.append(f'    "{key}": {value},')
            else:
                lines.append(f'    "{key}": "{value}",')
        lines.append("}")
        return '\n'.join(lines)


def format_output(data: Dict[str, Any], format_type: str = "json") -> str:
    """Format output based on specified format."""
    if format_type == "json":
        return json.dumps(data, indent=2, default=str)

    elif format_type == "yaml":
        lines = []

        def yaml_format(d: Dict, indent: int = 0):
            prefix = "  " * indent
            for key, value in d.items():
                if isinstance(value, dict):
                    lines.append(f"{prefix}{key}:")
                    yaml_format(value, indent + 1)
                elif isinstance(value, list):
                    lines.append(f"{prefix}{key}:")
                    for item in value:
                        if isinstance(item, dict):
                            lines.append(f"{prefix}  -")
                            yaml_format(item, indent + 2)
                        else:
                            lines.append(f"{prefix}  - {item}")
                else:
                    lines.append(f"{prefix}{key}: {value}")

        yaml_format(data)
        return '\n'.join(lines)

    elif format_type == "properties":
        if "properties" in data:
            return data["properties"]
        elif "config" in data:
            lines = []
            for key, value in data["config"].items():
                lines.append(f"{key}={value}")
            return '\n'.join(lines)

    return json.dumps(data, indent=2, default=str)


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Kafka Config Generator - Production-Ready Kafka Configuration Tool",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Generate topic configuration
  python kafka_config_generator.py --mode topic --name orders --partitions 12 --retention-days 7

  # Generate producer configuration
  python kafka_config_generator.py --mode producer --profile high-throughput --output properties

  # Generate consumer configuration
  python kafka_config_generator.py --mode consumer --group order_processor --profile exactly-once

  # Generate Kafka Streams config
  python kafka_config_generator.py --mode streams --app-id order_aggregator

  # Generate cluster configuration
  python kafka_config_generator.py --mode cluster --brokers 3 --zookeepers 3

  # Generate security configuration
  python kafka_config_generator.py --mode security --auth sasl-scram --ssl
        """
    )

    parser.add_argument('--version', action='version', version=f'%(prog)s {__version__}')

    # Mode selection
    parser.add_argument('--mode', '-m', required=True,
                       choices=['topic', 'producer', 'consumer', 'streams', 'connect', 'security', 'cluster'],
                       help='Configuration mode')

    # Common options
    parser.add_argument('--bootstrap-servers', '-b', help='Kafka bootstrap servers')
    parser.add_argument('--output', '-o', choices=['json', 'yaml', 'properties'], default='json',
                       help='Output format')
    parser.add_argument('--output-dir', help='Output directory for generated files')
    parser.add_argument('--verbose', '-v', action='store_true', help='Verbose output')

    # Topic options
    parser.add_argument('--name', '-n', help='Topic name')
    parser.add_argument('--partitions', '-p', type=int, default=12, help='Number of partitions')
    parser.add_argument('--replication-factor', '-r', type=int, default=3, help='Replication factor')
    parser.add_argument('--retention-days', type=int, default=7, help='Retention period in days')
    parser.add_argument('--cleanup-policy', choices=['delete', 'compact', 'delete,compact'], default='delete',
                       help='Cleanup policy')
    parser.add_argument('--compression', choices=['none', 'gzip', 'snappy', 'lz4', 'zstd'], default='lz4',
                       help='Compression type')

    # Producer options
    parser.add_argument('--profile', default='default',
                       help='Configuration profile (default, high-throughput, exactly-once, low-latency, ordered)')
    parser.add_argument('--transactional-id', help='Transactional ID for exactly-once producers')

    # Consumer options
    parser.add_argument('--group', '-g', help='Consumer group ID')

    # Streams options
    parser.add_argument('--app-id', help='Kafka Streams application ID')
    parser.add_argument('--state-dir', help='State store directory')
    parser.add_argument('--processing-guarantee', choices=['at_least_once', 'exactly_once', 'exactly_once_v2'],
                       default='exactly_once_v2', help='Processing guarantee')

    # Connect options
    parser.add_argument('--connector-type', choices=['source', 'sink'], default='source',
                       help='Connector type')
    parser.add_argument('--connector-class', help='Connector class')
    parser.add_argument('--tasks-max', type=int, default=1, help='Maximum number of tasks')

    # Security options
    parser.add_argument('--auth', choices=['none', 'sasl-plain', 'sasl-scram', 'sasl-oauthbearer', 'mtls'],
                       default='none', help='Authentication type')
    parser.add_argument('--ssl', action='store_true', help='Enable SSL encryption')
    parser.add_argument('--principal', help='Principal for ACL generation')

    # Cluster options
    parser.add_argument('--brokers', type=int, default=3, help='Number of Kafka brokers')
    parser.add_argument('--zookeepers', type=int, default=3, help='Number of Zookeeper nodes')
    parser.add_argument('--environment', choices=['development', 'staging', 'production'],
                       default='production', help='Target environment')

    args = parser.parse_args()

    generator = KafkaConfigGenerator(verbose=args.verbose)

    try:
        result = None

        if args.mode == 'topic':
            if not args.name:
                print("Error: --name required for topic mode", file=sys.stderr)
                sys.exit(1)
            result = generator.generate_topic_config(
                name=args.name,
                partitions=args.partitions,
                replication_factor=args.replication_factor,
                retention_days=args.retention_days,
                cleanup_policy=args.cleanup_policy,
                compression=args.compression
            )

        elif args.mode == 'producer':
            result = generator.generate_producer_config(
                profile=args.profile,
                bootstrap_servers=args.bootstrap_servers,
                transactional_id=args.transactional_id
            )

        elif args.mode == 'consumer':
            if not args.group:
                print("Error: --group required for consumer mode", file=sys.stderr)
                sys.exit(1)
            result = generator.generate_consumer_config(
                group_id=args.group,
                profile=args.profile,
                bootstrap_servers=args.bootstrap_servers
            )

        elif args.mode == 'streams':
            if not args.app_id:
                print("Error: --app-id required for streams mode", file=sys.stderr)
                sys.exit(1)
            result = generator.generate_streams_config(
                application_id=args.app_id,
                bootstrap_servers=args.bootstrap_servers,
                state_dir=args.state_dir,
                processing_guarantee=args.processing_guarantee
            )

        elif args.mode == 'connect':
            if not args.name:
                print("Error: --name required for connect mode", file=sys.stderr)
                sys.exit(1)
            result = generator.generate_connect_config(
                connector_name=args.name,
                connector_type=args.connector_type,
                connector_class=args.connector_class,
                tasks_max=args.tasks_max
            )

        elif args.mode == 'security':
            result = generator.generate_security_config(
                auth_type=args.auth,
                ssl_enabled=args.ssl,
                principal=args.principal
            )

        elif args.mode == 'cluster':
            result = generator.generate_cluster_config(
                broker_count=args.brokers,
                zookeeper_count=args.zookeepers,
                environment=args.environment
            )

        # Output result
        if result:
            output = format_output(result, args.output)

            if args.output_dir:
                os.makedirs(args.output_dir, exist_ok=True)
                filename = f"{args.mode}_config.{args.output}"
                filepath = os.path.join(args.output_dir, filename)
                with open(filepath, 'w') as f:
                    f.write(output)
                print(f"Configuration written to {filepath}")
            else:
                print(output)

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        if args.verbose:
            import traceback
            traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
