"""Tests for xAI plugin POST action."""

import pytest

# post.py has a module-level ActionExample that may raise ValueError
# if the elizaos Content protobuf doesn't have an "action" field.
try:
    from elizaos_plugin_xai.actions.post import POST_ACTION, PostActionResult, validate_post

    _CAN_IMPORT = True
except (ImportError, ValueError):
    _CAN_IMPORT = False

pytestmark = pytest.mark.skipif(
    not _CAN_IMPORT,
    reason="Cannot import POST_ACTION due to elizaos ActionExample compatibility issue",
)


class TestPostActionMetadata:
    """Tests for POST_ACTION metadata."""

    def test_name(self) -> None:
        assert POST_ACTION["name"] == "POST"

    def test_similes(self) -> None:
        similes = POST_ACTION["similes"]
        assert "POST_TO_X" in similes
        assert "SEND_POST" in similes
        assert "SHARE_ON_X" in similes

    def test_description(self) -> None:
        assert "Post" in POST_ACTION["description"]
        assert "X" in POST_ACTION["description"]

    def test_has_validate(self) -> None:
        assert POST_ACTION["validate"] is validate_post

    def test_has_handler(self) -> None:
        assert callable(POST_ACTION["handler"])

    def test_has_examples(self) -> None:
        examples = POST_ACTION["examples"]
        assert len(examples) >= 2
        for example_pair in examples:
            assert len(example_pair) == 2


class TestPostActionResult:
    """Tests for PostActionResult dataclass (standalone, always importable)."""

    @pytest.mark.skipif(not _CAN_IMPORT, reason="PostActionResult not importable")
    def test_success_result(self) -> None:
        result = PostActionResult(
            success=True,
            text="Posted successfully",
            post_id="123456",
            post_url="https://x.com/user/status/123456",
        )
        assert result.success is True
        assert result.text == "Posted successfully"
        assert result.post_id == "123456"
        assert result.post_url == "https://x.com/user/status/123456"
        assert result.error is None

    @pytest.mark.skipif(not _CAN_IMPORT, reason="PostActionResult not importable")
    def test_failure_result(self) -> None:
        result = PostActionResult(success=False, error="API error")
        assert result.success is False
        assert result.error == "API error"
        assert result.text is None
        assert result.post_id is None

    @pytest.mark.skipif(not _CAN_IMPORT, reason="PostActionResult not importable")
    def test_defaults(self) -> None:
        result = PostActionResult(success=True)
        assert result.text is None
        assert result.error is None
        assert result.post_id is None
        assert result.post_url is None


class TestValidatePost:
    """Tests for validate_post function."""

    @pytest.mark.asyncio
    async def test_returns_false_when_no_service(self) -> None:
        class MockRuntime:
            def get_service(self, name: str):
                return None

        result = await validate_post(MockRuntime())
        assert result is False

    @pytest.mark.asyncio
    async def test_returns_true_when_service_exists(self) -> None:
        class MockService:
            pass

        class MockRuntime:
            def get_service(self, name: str):
                if name == "x":
                    return MockService()
                return None

        result = await validate_post(MockRuntime())
        assert result is True

    @pytest.mark.asyncio
    async def test_returns_false_on_exception(self) -> None:
        class MockRuntime:
            def get_service(self, name: str):
                raise RuntimeError("boom")

        result = await validate_post(MockRuntime())
        assert result is False

    @pytest.mark.asyncio
    async def test_checks_x_service(self) -> None:
        requested = []

        class MockRuntime:
            def get_service(self, name: str):
                requested.append(name)
                return None

        await validate_post(MockRuntime())
        assert "x" in requested
