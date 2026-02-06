"""Tests for ACP Client."""

from __future__ import annotations

import pytest
from pytest_httpx import HTTPXMock

from elizaos_plugin_acp.client import AcpApiError, AcpClient
from elizaos_plugin_acp.types import (
    AcpClientConfig,
    CheckoutSession,
    CheckoutSessionStatus,
    CreateCheckoutSessionRequest,
    Item,
    LineItem,
    Total,
    TotalType,
)


@pytest.fixture
def acp_client() -> AcpClient:
    """Create an ACP client for testing."""
    config = AcpClientConfig(
        base_url="https://merchant.example.com",
        api_key="test_api_key",
        api_version="2026-01-30",
        default_currency="USD",
    )
    return AcpClient(config)


@pytest.fixture
def mock_session_response() -> dict:
    """Create a mock session response."""
    return {
        "id": "cs_test123",
        "status": "incomplete",
        "currency": "USD",
        "line_items": [
            {
                "id": "li_1",
                "item": {"id": "item_123"},
                "quantity": 2,
                "name": "Test Item",
            }
        ],
        "totals": [
            {"type": "subtotal", "display_text": "Subtotal", "amount": 1999},
            {"type": "total", "display_text": "Total", "amount": 1999},
        ],
        "fulfillment_options": [],
        "messages": [],
        "links": [],
    }


class TestAcpClient:
    """Tests for AcpClient."""

    @pytest.mark.asyncio
    async def test_create_checkout_session(
        self, acp_client: AcpClient, httpx_mock: HTTPXMock, mock_session_response: dict
    ) -> None:
        """Test creating a checkout session."""
        httpx_mock.add_response(
            method="POST",
            url="https://merchant.example.com/checkout_sessions",
            json=mock_session_response,
            status_code=201,
        )

        request = CreateCheckoutSessionRequest(
            line_items=[Item(id="item_123", quantity=2)],
            currency="USD",
        )

        result = await acp_client.create_checkout_session(request)

        assert result.id == "cs_test123"
        assert result.status == CheckoutSessionStatus.INCOMPLETE
        assert len(result.line_items) == 1

        await acp_client.close()

    @pytest.mark.asyncio
    async def test_get_checkout_session(
        self, acp_client: AcpClient, httpx_mock: HTTPXMock, mock_session_response: dict
    ) -> None:
        """Test getting a checkout session."""
        mock_session_response["status"] = "ready_for_payment"
        httpx_mock.add_response(
            method="GET",
            url="https://merchant.example.com/checkout_sessions/cs_test123",
            json=mock_session_response,
        )

        result = await acp_client.get_checkout_session("cs_test123")

        assert result.id == "cs_test123"
        assert result.status == CheckoutSessionStatus.READY_FOR_PAYMENT

        await acp_client.close()

    @pytest.mark.asyncio
    async def test_update_checkout_session(
        self, acp_client: AcpClient, httpx_mock: HTTPXMock, mock_session_response: dict
    ) -> None:
        """Test updating a checkout session."""
        mock_session_response["line_items"][0]["quantity"] = 3
        httpx_mock.add_response(
            method="POST",
            url="https://merchant.example.com/checkout_sessions/cs_test123",
            json=mock_session_response,
        )

        from elizaos_plugin_acp.types import UpdateCheckoutSessionRequest

        request = UpdateCheckoutSessionRequest(
            line_items=[Item(id="item_123", quantity=3)],
        )

        result = await acp_client.update_checkout_session("cs_test123", request)

        assert result.line_items[0].quantity == 3

        await acp_client.close()

    @pytest.mark.asyncio
    async def test_complete_checkout_session(
        self, acp_client: AcpClient, httpx_mock: HTTPXMock
    ) -> None:
        """Test completing a checkout session."""
        completed_response = {
            "id": "cs_test123",
            "status": "completed",
            "currency": "USD",
            "line_items": [],
            "totals": [],
            "fulfillment_options": [],
            "messages": [],
            "links": [],
            "order": {
                "id": "ord_123",
                "checkout_session_id": "cs_test123",
                "order_number": "ORD-12345",
                "permalink_url": "https://merchant.example.com/orders/ord_123",
            },
        }

        httpx_mock.add_response(
            method="POST",
            url="https://merchant.example.com/checkout_sessions/cs_test123/complete",
            json=completed_response,
        )

        from elizaos_plugin_acp.types import (
            CompleteCheckoutSessionRequest,
            PaymentCredential,
            PaymentData,
            PaymentInstrument,
        )

        request = CompleteCheckoutSessionRequest(
            payment_data=PaymentData(
                handler_id="stripe",
                instrument=PaymentInstrument(
                    type="card",
                    credential=PaymentCredential(
                        type="spt",
                        token="spt_test_token",
                    ),
                ),
            ),
        )

        result = await acp_client.complete_checkout_session("cs_test123", request)

        assert result.status == CheckoutSessionStatus.COMPLETED
        assert result.order is not None
        assert result.order.id == "ord_123"

        await acp_client.close()

    @pytest.mark.asyncio
    async def test_cancel_checkout_session(
        self, acp_client: AcpClient, httpx_mock: HTTPXMock
    ) -> None:
        """Test canceling a checkout session."""
        canceled_response = {
            "id": "cs_test123",
            "status": "canceled",
            "currency": "USD",
            "line_items": [],
            "totals": [],
            "fulfillment_options": [],
            "messages": [],
            "links": [],
        }

        httpx_mock.add_response(
            method="POST",
            url="https://merchant.example.com/checkout_sessions/cs_test123/cancel",
            json=canceled_response,
        )

        from elizaos_plugin_acp.types import (
            CancelCheckoutSessionRequest,
            IntentTrace,
            IntentTraceReasonCode,
        )

        request = CancelCheckoutSessionRequest(
            intent_trace=IntentTrace(
                reason_code=IntentTraceReasonCode.PRICE_SENSITIVITY,
                trace_summary="Found a better price elsewhere",
            ),
        )

        result = await acp_client.cancel_checkout_session("cs_test123", request)

        assert result.status == CheckoutSessionStatus.CANCELED

        await acp_client.close()

    @pytest.mark.asyncio
    async def test_error_response(
        self, acp_client: AcpClient, httpx_mock: HTTPXMock
    ) -> None:
        """Test handling error responses."""
        error_response = {
            "type": "invalid_request",
            "code": "missing_field",
            "message": "line_items is required",
            "param": "line_items",
        }

        httpx_mock.add_response(
            method="POST",
            url="https://merchant.example.com/checkout_sessions",
            json=error_response,
            status_code=400,
        )

        request = CreateCheckoutSessionRequest(
            line_items=[],
            currency="USD",
        )

        with pytest.raises(AcpApiError) as exc_info:
            await acp_client.create_checkout_session(request)

        assert exc_info.value.type == "invalid_request"
        assert exc_info.value.code == "missing_field"

        await acp_client.close()


class TestAcpApiError:
    """Tests for AcpApiError."""

    def test_error_creation(self) -> None:
        """Test creating an error with correct properties."""
        error = AcpApiError(
            "invalid_request",
            "missing_field",
            "line_items is required",
            "line_items",
        )

        assert error.type == "invalid_request"
        assert error.code == "missing_field"
        assert str(error) == "line_items is required"
        assert error.param == "line_items"

    def test_error_to_dict(self) -> None:
        """Test serializing error to dictionary."""
        error = AcpApiError(
            "processing_error",
            "payment_failed",
            "Payment was declined",
        )

        result = error.to_dict()

        assert result["type"] == "processing_error"
        assert result["code"] == "payment_failed"
        assert result["message"] == "Payment was declined"
        assert result["param"] is None
