"""Integration tests for browser plugin action handlers."""

from __future__ import annotations

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from elizaos_browser.actions.click import browser_click
from elizaos_browser.actions.extract import browser_extract
from elizaos_browser.actions.navigate import browser_navigate
from elizaos_browser.actions.screenshot import browser_screenshot
from elizaos_browser.actions.select import browser_select
from elizaos_browser.actions.type import browser_type
from elizaos_browser.providers.browser_state import get_browser_state
from elizaos_browser.types import (
    ActionResult,
    BrowserSession,
    NavigationResult,
    WebSocketResponse,
)
from elizaos_browser.utils.errors import ActionError

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

MOCK_SESSION = BrowserSession(id="sess-1", created_at=datetime.now())


def _make_service(
    *,
    session: BrowserSession | None = MOCK_SESSION,
    no_session: bool = False,
) -> MagicMock:
    """Create a mock BrowserService with a mock WebSocket client."""
    mock_client = MagicMock()
    # Default all client async methods to successful no-ops
    mock_client.navigate = AsyncMock(
        return_value=NavigationResult(
            success=True, url="https://example.com", title="Example"
        )
    )
    mock_client.click = AsyncMock(
        return_value=WebSocketResponse(
            type="click", request_id="r1", success=True, data={}
        )
    )
    mock_client.type_text = AsyncMock(
        return_value=WebSocketResponse(
            type="type", request_id="r1", success=True, data={}
        )
    )
    mock_client.select = AsyncMock(
        return_value=WebSocketResponse(
            type="select", request_id="r1", success=True, data={}
        )
    )
    mock_client.extract = AsyncMock(
        return_value=WebSocketResponse(
            type="extract",
            request_id="r1",
            success=True,
            data={"found": True, "data": "extracted text"},
        )
    )
    mock_client.screenshot = AsyncMock(
        return_value=WebSocketResponse(
            type="screenshot",
            request_id="r1",
            success=True,
            data={
                "url": "https://example.com",
                "title": "Example",
                "screenshot": "base64data",
                "mimeType": "image/png",
            },
        )
    )
    mock_client.get_state = AsyncMock(
        return_value={"url": "https://example.com", "title": "Example"}
    )

    svc = MagicMock()
    svc.get_client.return_value = mock_client
    svc._mock_client = mock_client  # convenience accessor for tests

    if no_session:
        svc.get_or_create_session = AsyncMock(return_value=None)
        svc.get_current_session = AsyncMock(return_value=None)
    else:
        svc.get_or_create_session = AsyncMock(return_value=session)
        svc.get_current_session = AsyncMock(return_value=session)

    return svc


# ===========================================================================
# BROWSER_NAVIGATE
# ===========================================================================


class TestBrowserNavigate:
    @pytest.mark.asyncio
    async def test_missing_url_returns_error(self) -> None:
        svc = _make_service()
        result = await browser_navigate(svc, "please navigate somewhere nice")
        assert not result.success
        assert result.error == "no_url_found"

    @pytest.mark.asyncio
    async def test_valid_url_success(self) -> None:
        svc = _make_service()
        result = await browser_navigate(svc, "Navigate to https://example.com")
        assert result.success
        assert result.data is not None
        assert result.data["url"] == "https://example.com"
        assert result.data["title"] == "Example"

    @pytest.mark.asyncio
    async def test_security_error_for_blocked_url(self) -> None:
        svc = _make_service()
        result = await browser_navigate(svc, "Go to https://malware.com/bad")
        assert not result.success
        assert result.error == "security_error"

    @pytest.mark.asyncio
    async def test_callback_invoked_on_success(self) -> None:
        svc = _make_service()
        cb = MagicMock()
        await browser_navigate(svc, "Navigate to https://example.com", callback=cb)
        cb.assert_called_once()
        args = cb.call_args[0][0]
        assert "BROWSER_NAVIGATE" in args["actions"]


# ===========================================================================
# BROWSER_CLICK
# ===========================================================================


class TestBrowserClick:
    @pytest.mark.asyncio
    async def test_no_session_returns_error(self) -> None:
        svc = _make_service(no_session=True)
        result = await browser_click(svc, "Click on the submit button")
        assert not result.success
        assert result.error == "no_session"

    @pytest.mark.asyncio
    async def test_click_success(self) -> None:
        svc = _make_service()
        result = await browser_click(svc, "Click on the submit button")
        assert result.success
        assert result.data is not None
        assert result.data["element"] == "the submit button"

    @pytest.mark.asyncio
    async def test_click_failure_raises(self) -> None:
        svc = _make_service()
        svc._mock_client.click = AsyncMock(
            return_value=WebSocketResponse(
                type="click",
                request_id="r1",
                success=False,
                error="Element not found",
            )
        )
        with pytest.raises(ActionError):
            await browser_click(svc, "Click on the missing element")


# ===========================================================================
# BROWSER_TYPE
# ===========================================================================


class TestBrowserType:
    @pytest.mark.asyncio
    async def test_no_session_returns_error(self) -> None:
        svc = _make_service(no_session=True)
        result = await browser_type(svc, 'Type "hello" in the search box')
        assert not result.success
        assert result.error == "no_session"

    @pytest.mark.asyncio
    async def test_missing_text_raises(self) -> None:
        svc = _make_service()
        with pytest.raises(ActionError):
            await browser_type(svc, "Type something in the search box")

    @pytest.mark.asyncio
    async def test_type_success(self) -> None:
        svc = _make_service()
        result = await browser_type(svc, 'Type "hello world" in the search box')
        assert result.success
        assert result.data is not None
        assert result.data["textTyped"] == "hello world"


# ===========================================================================
# BROWSER_SELECT
# ===========================================================================


class TestBrowserSelect:
    @pytest.mark.asyncio
    async def test_no_session_returns_error(self) -> None:
        svc = _make_service(no_session=True)
        result = await browser_select(svc, 'Select "USA" from the country dropdown')
        assert not result.success
        assert result.error == "no_session"

    @pytest.mark.asyncio
    async def test_missing_option_raises(self) -> None:
        svc = _make_service()
        with pytest.raises(ActionError):
            await browser_select(svc, "Select something from the dropdown")

    @pytest.mark.asyncio
    async def test_select_success(self) -> None:
        svc = _make_service()
        result = await browser_select(
            svc, 'Select "United States" from the country dropdown'
        )
        assert result.success
        assert result.data is not None
        assert result.data["option"] == "United States"


# ===========================================================================
# BROWSER_EXTRACT
# ===========================================================================


class TestBrowserExtract:
    @pytest.mark.asyncio
    async def test_no_session_returns_error(self) -> None:
        svc = _make_service(no_session=True)
        result = await browser_extract(svc, "Extract the main heading")
        assert not result.success
        assert result.error == "no_session"

    @pytest.mark.asyncio
    async def test_extract_success(self) -> None:
        svc = _make_service()
        result = await browser_extract(svc, "Extract the main heading from the page")
        assert result.success
        assert result.data is not None
        assert result.data["found"] is True

    @pytest.mark.asyncio
    async def test_extract_failure_raises(self) -> None:
        svc = _make_service()
        svc._mock_client.extract = AsyncMock(
            return_value=WebSocketResponse(
                type="extract",
                request_id="r1",
                success=False,
                error="Extraction failed",
            )
        )
        with pytest.raises(ActionError):
            await browser_extract(svc, "Extract the sidebar from the page")


# ===========================================================================
# BROWSER_SCREENSHOT
# ===========================================================================


class TestBrowserScreenshot:
    @pytest.mark.asyncio
    async def test_no_session_returns_error(self) -> None:
        svc = _make_service(no_session=True)
        result = await browser_screenshot(svc, "Take a screenshot")
        assert not result.success
        assert result.error == "no_session"

    @pytest.mark.asyncio
    async def test_screenshot_success(self) -> None:
        svc = _make_service()
        result = await browser_screenshot(svc, "Take a screenshot of the page")
        assert result.success
        assert result.data is not None
        assert result.data["url"] == "https://example.com"

    @pytest.mark.asyncio
    async def test_screenshot_failure_raises(self) -> None:
        svc = _make_service()
        svc._mock_client.screenshot = AsyncMock(
            return_value=WebSocketResponse(
                type="screenshot",
                request_id="r1",
                success=False,
                error="Screenshot failed",
            )
        )
        with pytest.raises(ActionError):
            await browser_screenshot(svc, "Take a screenshot")


# ===========================================================================
# BROWSER_STATE provider
# ===========================================================================


class TestBrowserStateProvider:
    @pytest.mark.asyncio
    async def test_returns_state_with_active_session(self) -> None:
        svc = _make_service()
        result = await get_browser_state(svc)
        assert result["values"]["hasSession"] is True
        assert result["values"]["url"] == "https://example.com"
        assert result["values"]["title"] == "Example"
        assert "Current browser page" in result["text"]

    @pytest.mark.asyncio
    async def test_returns_no_session_when_unavailable(self) -> None:
        svc = _make_service(no_session=True)
        result = await get_browser_state(svc)
        assert result["text"] == "No active browser session"
        assert result["values"]["hasSession"] is False
