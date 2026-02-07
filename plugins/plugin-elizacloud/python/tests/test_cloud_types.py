"""Tests for cloud-specific types."""

from elizaos_plugin_elizacloud.types.cloud import (
    AgentSnapshot,
    BackupConfig,
    BridgeConfig,
    BridgeConnection,
    BridgeError,
    BridgeMessage,
    CloudApiError,
    CloudApiErrorBody,
    CloudContainer,
    CloudCredentials,
    CloudPluginConfig,
    ContainerDefaults,
    ContainerHealthData,
    CreateContainerRequest,
    CreditTransaction,
    DEFAULT_CLOUD_CONFIG,
    DeviceAuthRequest,
    InsufficientCreditsError,
    PollingInfo,
)


class TestCloudContainer:
    def test_create_container(self) -> None:
        c = CloudContainer(
            id="c-123",
            name="my-agent",
            project_name="test-project",
            description="A test container",
            organization_id="org-1",
            user_id="user-1",
            status="running",
            image_tag="latest",
            port=3000,
            desired_count=1,
            cpu=1792,
            memory=1792,
            architecture="arm64",
            environment_vars={"KEY": "value"},
            health_check_path="/health",
            load_balancer_url="https://lb.example.com",
            ecr_repository_uri=None,
            ecr_image_tag=None,
            cloudformation_stack_name="stack-123",
            billing_status="active",
            total_billed="12.50",
            last_deployed_at="2025-01-01T00:00:00Z",
            last_health_check="2025-01-01T01:00:00Z",
            deployment_log=None,
            error_message=None,
            metadata={},
            created_at="2025-01-01T00:00:00Z",
            updated_at="2025-01-01T01:00:00Z",
        )
        assert c.id == "c-123"
        assert c.status == "running"
        assert c.billing_status == "active"
        assert c.environment_vars["KEY"] == "value"

    def test_container_statuses(self) -> None:
        for status in ["pending", "building", "deploying", "running", "stopped", "failed", "suspended"]:
            c = CloudContainer(
                id="x", name="x", project_name="x", description=None,
                organization_id="x", user_id="x", status=status,  # type: ignore[arg-type]
                image_tag=None, port=3000, desired_count=1, cpu=1792, memory=1792,
                architecture="arm64", environment_vars={}, health_check_path="/health",
                load_balancer_url=None, ecr_repository_uri=None, ecr_image_tag=None,
                cloudformation_stack_name=None, billing_status="active",
                total_billed="0", last_deployed_at=None, last_health_check=None,
                deployment_log=None, error_message=None, metadata={},
                created_at="", updated_at="",
            )
            assert c.status == status


class TestCreateContainerRequest:
    def test_required_fields(self) -> None:
        req = CreateContainerRequest(
            name="my-agent",
            project_name="test-project",
            ecr_image_uri="elizaos/agent:latest",
        )
        assert req.name == "my-agent"
        assert req.project_name == "test-project"
        assert req.ecr_image_uri == "elizaos/agent:latest"

    def test_optional_fields_default_none(self) -> None:
        req = CreateContainerRequest(
            name="a", project_name="b", ecr_image_uri="c",
        )
        assert req.description is None
        assert req.port is None
        assert req.cpu is None
        assert req.memory is None
        assert req.architecture is None

    def test_full_request(self) -> None:
        req = CreateContainerRequest(
            name="my-agent",
            project_name="test-project",
            ecr_image_uri="elizaos/agent:latest",
            description="Test agent",
            port=3000,
            cpu=1792,
            memory=1792,
            architecture="x86_64",
            environment_vars={"KEY": "val"},
        )
        assert req.architecture == "x86_64"
        assert req.environment_vars == {"KEY": "val"}


class TestAuthTypes:
    def test_device_auth_request(self) -> None:
        req = DeviceAuthRequest(
            device_id="abc123",
            platform="macos",
            app_version="2.0.0",
            device_name="my-mac",
        )
        assert req.device_id == "abc123"
        assert req.platform == "macos"

    def test_cloud_credentials(self) -> None:
        creds = CloudCredentials(
            api_key="key-123",
            user_id="user-1",
            organization_id="org-1",
            authenticated_at=1700000000.0,
        )
        assert creds.api_key == "key-123"
        assert creds.authenticated_at == 1700000000.0


class TestCreditTypes:
    def test_credit_transaction(self) -> None:
        tx = CreditTransaction(
            id="tx-1",
            amount=-5.00,
            description="Container deployment",
            type="debit",
            created_at="2025-01-01T00:00:00Z",
        )
        assert tx.amount == -5.00
        assert tx.type == "debit"


class TestBridgeTypes:
    def test_bridge_message(self) -> None:
        msg = BridgeMessage(jsonrpc="2.0", id=1, method="heartbeat")
        assert msg.jsonrpc == "2.0"
        assert msg.id == 1
        assert msg.params is None

    def test_bridge_error(self) -> None:
        err = BridgeError(code=-32600, message="Invalid request")
        assert err.code == -32600
        assert err.data is None

    def test_bridge_connection(self) -> None:
        conn = BridgeConnection(
            container_id="c-123",
            state="connected",
            connected_at=1700000000.0,
            last_heartbeat=1700000010.0,
            reconnect_attempts=0,
        )
        assert conn.state == "connected"


class TestSnapshotTypes:
    def test_agent_snapshot(self) -> None:
        snap = AgentSnapshot(
            id="snap-1",
            container_id="c-123",
            organization_id="org-1",
            snapshot_type="manual",
            storage_url="s3://bucket/snap-1.tar.gz",
            size_bytes=1048576,
            agent_config={"model": "gpt-5"},
            metadata={"trigger": "user"},
            created_at="2025-01-01T00:00:00Z",
        )
        assert snap.snapshot_type == "manual"
        assert snap.size_bytes == 1048576


class TestCloudPluginConfig:
    def test_default_config(self) -> None:
        cfg = DEFAULT_CLOUD_CONFIG
        assert cfg.enabled is False
        assert cfg.base_url == "https://www.elizacloud.ai/api/v1"
        assert cfg.inference_mode == "cloud"
        assert cfg.auto_provision is False

    def test_bridge_defaults(self) -> None:
        cfg = DEFAULT_CLOUD_CONFIG
        assert cfg.bridge.reconnect_interval_ms == 3000
        assert cfg.bridge.max_reconnect_attempts == 20
        assert cfg.bridge.heartbeat_interval_ms == 30_000

    def test_backup_defaults(self) -> None:
        cfg = DEFAULT_CLOUD_CONFIG
        assert cfg.backup.auto_backup_interval_ms == 3_600_000
        assert cfg.backup.max_snapshots == 10

    def test_container_defaults(self) -> None:
        cfg = DEFAULT_CLOUD_CONFIG
        assert cfg.container.default_image == "elizaos/agent:latest"
        assert cfg.container.default_architecture == "arm64"
        assert cfg.container.default_cpu == 1792
        assert cfg.container.default_memory == 1792
        assert cfg.container.default_port == 3000

    def test_custom_config(self) -> None:
        cfg = CloudPluginConfig(
            enabled=True,
            base_url="https://custom.api.com",
            inference_mode="byok",
            bridge=BridgeConfig(reconnect_interval_ms=5000),
            backup=BackupConfig(max_snapshots=5),
            container=ContainerDefaults(default_cpu=2048),
        )
        assert cfg.enabled is True
        assert cfg.bridge.reconnect_interval_ms == 5000
        assert cfg.backup.max_snapshots == 5
        assert cfg.container.default_cpu == 2048


class TestCloudApiErrors:
    def test_cloud_api_error(self) -> None:
        body = CloudApiErrorBody(success=False, error="Not found")
        err = CloudApiError(404, body)
        assert err.status_code == 404
        assert str(err) == "Not found"
        assert err.error_body.error == "Not found"

    def test_insufficient_credits_error(self) -> None:
        body = CloudApiErrorBody(
            success=False,
            error="Insufficient credits",
            required_credits=10.0,
        )
        err = InsufficientCreditsError(body)
        assert err.status_code == 402
        assert err.required_credits == 10.0
        assert isinstance(err, CloudApiError)

    def test_error_with_details(self) -> None:
        body = CloudApiErrorBody(
            success=False,
            error="Quota exceeded",
            details={"limit": "10 containers"},
            quota={"current": 10, "max": 10},
        )
        err = CloudApiError(429, body)
        assert err.error_body.quota == {"current": 10, "max": 10}
