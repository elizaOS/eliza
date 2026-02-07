"""
Cloud-specific types for ElizaCloud integration.

These types mirror the eliza-cloud-v2 database schemas and API contracts
for containers, auth, credits, bridge messaging, and agent state snapshots.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Literal


# ─── Container Types ────────────────────────────────────────────────────────

ContainerStatus = Literal[
    "pending", "building", "deploying", "running", "stopped", "failed", "suspended"
]

ContainerBillingStatus = Literal[
    "active", "warning", "suspended", "shutdown_pending", "archived"
]

ContainerArchitecture = Literal["arm64", "x86_64"]


@dataclass
class CloudContainer:
    id: str
    name: str
    project_name: str
    description: str | None
    organization_id: str
    user_id: str
    status: ContainerStatus
    image_tag: str | None
    port: int
    desired_count: int
    cpu: int
    memory: int
    architecture: ContainerArchitecture
    environment_vars: dict[str, str]
    health_check_path: str
    load_balancer_url: str | None
    ecr_repository_uri: str | None
    ecr_image_tag: str | None
    cloudformation_stack_name: str | None
    billing_status: ContainerBillingStatus
    total_billed: str
    last_deployed_at: str | None
    last_health_check: str | None
    deployment_log: str | None
    error_message: str | None
    metadata: dict[str, object]
    created_at: str
    updated_at: str


@dataclass
class CreateContainerRequest:
    name: str
    project_name: str
    ecr_image_uri: str
    description: str | None = None
    port: int | None = None
    desired_count: int | None = None
    cpu: int | None = None
    memory: int | None = None
    environment_vars: dict[str, str] | None = None
    health_check_path: str | None = None
    ecr_repository_uri: str | None = None
    image_tag: str | None = None
    architecture: ContainerArchitecture | None = None


@dataclass
class PollingInfo:
    endpoint: str
    interval_ms: int
    expected_duration_ms: int


@dataclass
class CreateContainerResponse:
    success: bool
    data: CloudContainer
    message: str
    credits_deducted: float
    credits_remaining: float
    stack_name: str
    polling: PollingInfo


@dataclass
class ContainerListResponse:
    success: bool
    data: list[CloudContainer]


@dataclass
class ContainerGetResponse:
    success: bool
    data: CloudContainer


@dataclass
class ContainerDeleteResponse:
    success: bool
    message: str | None = None


@dataclass
class ContainerHealthData:
    status: str
    healthy: bool
    last_check: str | None
    uptime: int | None


@dataclass
class ContainerHealthResponse:
    success: bool
    data: ContainerHealthData


# ─── Auth Types ─────────────────────────────────────────────────────────────

DevicePlatform = Literal["ios", "android", "macos", "windows", "linux", "web"]


@dataclass
class DeviceAuthRequest:
    device_id: str
    platform: DevicePlatform
    app_version: str
    device_name: str | None = None


@dataclass
class DeviceAuthData:
    api_key: str
    user_id: str
    organization_id: str
    credits: float
    is_new: bool


@dataclass
class DeviceAuthResponse:
    success: bool
    data: DeviceAuthData


@dataclass
class CloudCredentials:
    api_key: str
    user_id: str
    organization_id: str
    authenticated_at: float


# ─── Credits Types ──────────────────────────────────────────────────────────


@dataclass
class CreditBalanceData:
    balance: float
    currency: str


@dataclass
class CreditBalanceResponse:
    success: bool
    data: CreditBalanceData


@dataclass
class CreditTransaction:
    id: str
    amount: float
    description: str
    type: Literal["credit", "debit"]
    created_at: str


@dataclass
class CreditSummaryData:
    balance: float
    total_spent: float
    total_added: float
    recent_transactions: list[CreditTransaction]


@dataclass
class CreditSummaryResponse:
    success: bool
    data: CreditSummaryData


# ─── Bridge Types ───────────────────────────────────────────────────────────

BridgeConnectionState = Literal["disconnected", "connecting", "connected", "reconnecting"]


@dataclass
class BridgeError:
    code: int
    message: str
    data: object | None = None


@dataclass
class BridgeMessage:
    jsonrpc: str = "2.0"
    id: str | int | None = None
    method: str | None = None
    params: dict[str, object] | None = None
    result: object | None = None
    error: BridgeError | None = None


@dataclass
class BridgeConnection:
    container_id: str
    state: BridgeConnectionState
    connected_at: float | None
    last_heartbeat: float | None
    reconnect_attempts: int


# ─── Snapshot / Backup Types ────────────────────────────────────────────────

SnapshotType = Literal["manual", "auto", "pre-eviction"]


@dataclass
class AgentSnapshot:
    id: str
    container_id: str
    organization_id: str
    snapshot_type: SnapshotType
    storage_url: str
    size_bytes: int
    agent_config: dict[str, object]
    metadata: dict[str, object]
    created_at: str


@dataclass
class CreateSnapshotRequest:
    snapshot_type: SnapshotType = "manual"
    metadata: dict[str, object] | None = None


@dataclass
class CreateSnapshotResponse:
    success: bool
    data: AgentSnapshot


@dataclass
class SnapshotListResponse:
    success: bool
    data: list[AgentSnapshot]


@dataclass
class RestoreSnapshotRequest:
    snapshot_id: str


@dataclass
class RestoreSnapshotResponse:
    success: bool
    message: str


# ─── Cloud Config Types ─────────────────────────────────────────────────────

InferenceMode = Literal["cloud", "byok", "local"]


@dataclass
class BridgeConfig:
    reconnect_interval_ms: int = 3000
    max_reconnect_attempts: int = 20
    heartbeat_interval_ms: int = 30_000


@dataclass
class BackupConfig:
    auto_backup_interval_ms: int = 3_600_000  # 1 hour
    max_snapshots: int = 10


@dataclass
class ContainerDefaults:
    default_image: str = "elizaos/agent:latest"
    default_architecture: ContainerArchitecture = "arm64"
    default_cpu: int = 1792
    default_memory: int = 1792
    default_port: int = 3000


@dataclass
class CloudPluginConfig:
    """Configuration for the ElizaCloud plugin."""

    enabled: bool = False
    base_url: str = "https://www.elizacloud.ai/api/v1"
    api_key: str | None = None
    device_id: str | None = None
    platform: DevicePlatform | None = None
    inference_mode: InferenceMode = "cloud"
    auto_provision: bool = False
    bridge: BridgeConfig = field(default_factory=BridgeConfig)
    backup: BackupConfig = field(default_factory=BackupConfig)
    container: ContainerDefaults = field(default_factory=ContainerDefaults)


DEFAULT_CLOUD_CONFIG = CloudPluginConfig()


# ─── API Error Types ────────────────────────────────────────────────────────


@dataclass
class CloudApiErrorBody:
    success: bool  # always False
    error: str
    details: dict[str, object] | None = None
    required_credits: float | None = None
    quota: dict[str, int] | None = None


class CloudApiError(Exception):
    """Error returned by the ElizaCloud API."""

    def __init__(self, status_code: int, body: CloudApiErrorBody) -> None:
        super().__init__(body.error)
        self.status_code = status_code
        self.error_body = body


class InsufficientCreditsError(CloudApiError):
    """Raised when the user doesn't have enough credits."""

    def __init__(self, body: CloudApiErrorBody) -> None:
        super().__init__(402, body)
        self.required_credits = body.required_credits or 0.0


__all__ = [
    "ContainerStatus",
    "ContainerBillingStatus",
    "ContainerArchitecture",
    "CloudContainer",
    "CreateContainerRequest",
    "PollingInfo",
    "CreateContainerResponse",
    "ContainerListResponse",
    "ContainerGetResponse",
    "ContainerDeleteResponse",
    "ContainerHealthData",
    "ContainerHealthResponse",
    "DevicePlatform",
    "DeviceAuthRequest",
    "DeviceAuthData",
    "DeviceAuthResponse",
    "CloudCredentials",
    "CreditBalanceData",
    "CreditBalanceResponse",
    "CreditTransaction",
    "CreditSummaryData",
    "CreditSummaryResponse",
    "BridgeConnectionState",
    "BridgeError",
    "BridgeMessage",
    "BridgeConnection",
    "SnapshotType",
    "AgentSnapshot",
    "CreateSnapshotRequest",
    "CreateSnapshotResponse",
    "SnapshotListResponse",
    "RestoreSnapshotRequest",
    "RestoreSnapshotResponse",
    "InferenceMode",
    "BridgeConfig",
    "BackupConfig",
    "ContainerDefaults",
    "CloudPluginConfig",
    "DEFAULT_CLOUD_CONFIG",
    "CloudApiErrorBody",
    "CloudApiError",
    "InsufficientCreditsError",
]
