"""Tests for ACP types."""

from __future__ import annotations

import pytest

from elizaos_plugin_acp.types import (
    Address,
    AppliedDiscount,
    Buyer,
    CheckoutSession,
    CheckoutSessionStatus,
    Coupon,
    CreateCheckoutSessionRequest,
    FulfillmentDetails,
    FulfillmentOptionShipping,
    IntentTrace,
    IntentTraceReasonCode,
    Item,
    LineItem,
    Order,
    PaymentData,
    PaymentCredential,
    PaymentInstrument,
    Total,
    TotalType,
)


class TestCheckoutSession:
    """Tests for CheckoutSession type."""

    def test_valid_session(self) -> None:
        """Test creating a valid checkout session."""
        session = CheckoutSession(
            id="cs_123",
            status=CheckoutSessionStatus.READY_FOR_PAYMENT,
            currency="USD",
            line_items=[
                LineItem(
                    id="li_1",
                    item=Item(id="item_123", name="Widget", unit_amount=999),
                    quantity=2,
                    name="Widget",
                )
            ],
            totals=[
                Total(type=TotalType.SUBTOTAL, display_text="Subtotal", amount=1998),
                Total(type=TotalType.TAX, display_text="Tax", amount=180),
                Total(type=TotalType.TOTAL, display_text="Total", amount=2178),
            ],
            fulfillment_options=[
                FulfillmentOptionShipping(
                    id="ship_1",
                    title="Standard Shipping",
                    totals=[Total(type=TotalType.FULFILLMENT, display_text="Shipping", amount=599)],
                )
            ],
            messages=[],
            links=[],
        )

        assert session.id == "cs_123"
        assert session.status == CheckoutSessionStatus.READY_FOR_PAYMENT
        assert len(session.line_items) == 1
        assert len(session.totals) == 3

    def test_all_status_values(self) -> None:
        """Test all valid status values."""
        statuses = [
            CheckoutSessionStatus.INCOMPLETE,
            CheckoutSessionStatus.NOT_READY_FOR_PAYMENT,
            CheckoutSessionStatus.REQUIRES_ESCALATION,
            CheckoutSessionStatus.AUTHENTICATION_REQUIRED,
            CheckoutSessionStatus.READY_FOR_PAYMENT,
            CheckoutSessionStatus.PENDING_APPROVAL,
            CheckoutSessionStatus.COMPLETE_IN_PROGRESS,
            CheckoutSessionStatus.COMPLETED,
            CheckoutSessionStatus.CANCELED,
            CheckoutSessionStatus.IN_PROGRESS,
            CheckoutSessionStatus.EXPIRED,
        ]

        for status in statuses:
            session = CheckoutSession(
                id="cs_test",
                status=status,
                currency="USD",
                line_items=[],
                totals=[],
                fulfillment_options=[],
                messages=[],
                links=[],
            )
            assert session.status == status


class TestLineItem:
    """Tests for LineItem type."""

    def test_line_item_with_all_fields(self) -> None:
        """Test creating a line item with all fields."""
        line_item = LineItem(
            id="li_123",
            item=Item(id="item_456", name="Blue Widget", unit_amount=1999),
            quantity=3,
            name="Blue Widget",
            description="A wonderful blue widget",
            images=["https://example.com/widget.jpg"],
            unit_amount=1999,
            product_id="prod_789",
            sku="WIDGET-BLUE-001",
            variant_id="var_abc",
            category="Widgets",
            tags=["blue", "widget", "sale"],
            availability_status="in_stock",
            available_quantity=100,
            max_quantity_per_order=10,
            totals=[Total(type=TotalType.SUBTOTAL, display_text="Item Total", amount=5997)],
        )

        assert line_item.id == "li_123"
        assert line_item.quantity == 3
        assert line_item.availability_status == "in_stock"


class TestTotal:
    """Tests for Total type."""

    def test_all_total_types(self) -> None:
        """Test all total types."""
        total_types = [
            TotalType.ITEMS_BASE_AMOUNT,
            TotalType.ITEMS_DISCOUNT,
            TotalType.SUBTOTAL,
            TotalType.DISCOUNT,
            TotalType.FULFILLMENT,
            TotalType.TAX,
            TotalType.FEE,
            TotalType.GIFT_WRAP,
            TotalType.TIP,
            TotalType.STORE_CREDIT,
            TotalType.TOTAL,
        ]

        for total_type in total_types:
            total = Total(
                type=total_type,
                display_text=f"{total_type.value} amount",
                amount=1000,
            )
            assert total.type == total_type


class TestOrder:
    """Tests for Order type."""

    def test_completed_order(self) -> None:
        """Test creating a completed order."""
        from elizaos_plugin_acp.types import EstimatedDelivery, OrderConfirmation, SupportInfo

        order = Order(
            id="ord_123",
            checkout_session_id="cs_456",
            order_number="ORD-2026-0001",
            permalink_url="https://merchant.example.com/orders/ord_123",
            status="confirmed",
            estimated_delivery=EstimatedDelivery(
                earliest="2026-02-10T00:00:00Z",
                latest="2026-02-12T00:00:00Z",
            ),
            confirmation=OrderConfirmation(
                confirmation_number="CONF-ABC123",
                confirmation_email_sent=True,
                receipt_url="https://merchant.example.com/receipts/rcpt_789",
            ),
            support=SupportInfo(
                email="support@merchant.example.com",
                phone="+1-800-555-1234",
            ),
        )

        assert order.status == "confirmed"
        assert order.confirmation is not None
        assert order.confirmation.confirmation_email_sent is True


class TestPaymentData:
    """Tests for PaymentData type."""

    def test_payment_with_instrument(self) -> None:
        """Test payment data with handler and instrument."""
        payment_data = PaymentData(
            handler_id="stripe_handler",
            instrument=PaymentInstrument(
                type="card",
                credential=PaymentCredential(
                    type="spt",
                    token="spt_test_token_123",
                ),
            ),
            billing_address=Address(
                name="John Doe",
                line_one="123 Main St",
                city="San Francisco",
                state="CA",
                country="US",
                postal_code="94102",
            ),
        )

        assert payment_data.handler_id == "stripe_handler"
        assert payment_data.instrument is not None
        assert payment_data.instrument.credential.type == "spt"

    def test_payment_with_purchase_order(self) -> None:
        """Test payment data with purchase order."""
        payment_data = PaymentData(
            purchase_order_number="PO-2026-001",
            payment_terms="net_30",
            due_date="2026-03-05T00:00:00Z",
            approval_required=True,
        )

        assert payment_data.payment_terms == "net_30"
        assert payment_data.approval_required is True


class TestIntentTrace:
    """Tests for IntentTrace type."""

    def test_all_reason_codes(self) -> None:
        """Test all reason codes."""
        reason_codes = [
            IntentTraceReasonCode.PRICE_SENSITIVITY,
            IntentTraceReasonCode.SHIPPING_COST,
            IntentTraceReasonCode.SHIPPING_SPEED,
            IntentTraceReasonCode.PRODUCT_FIT,
            IntentTraceReasonCode.TRUST_SECURITY,
            IntentTraceReasonCode.RETURNS_POLICY,
            IntentTraceReasonCode.PAYMENT_OPTIONS,
            IntentTraceReasonCode.COMPARISON,
            IntentTraceReasonCode.TIMING_DEFERRED,
            IntentTraceReasonCode.OTHER,
        ]

        for reason_code in reason_codes:
            trace = IntentTrace(
                reason_code=reason_code,
                trace_summary=f"Abandoned due to {reason_code.value}",
            )
            assert trace.reason_code == reason_code

    def test_intent_trace_with_metadata(self) -> None:
        """Test intent trace with metadata."""
        trace = IntentTrace(
            reason_code=IntentTraceReasonCode.PRICE_SENSITIVITY,
            trace_summary="User mentioned price was too high",
            metadata={
                "competitor_price": 1999,
                "price_difference_percent": 15,
                "mentioned_competitor": True,
            },
        )

        assert trace.metadata is not None
        assert trace.metadata["competitor_price"] == 1999


class TestCreateCheckoutSessionRequest:
    """Tests for CreateCheckoutSessionRequest type."""

    def test_minimal_request(self) -> None:
        """Test creating a minimal request."""
        request = CreateCheckoutSessionRequest(
            line_items=[Item(id="item_123", quantity=1)],
            currency="USD",
        )

        assert len(request.line_items) == 1
        assert request.currency == "USD"

    def test_full_request(self) -> None:
        """Test creating a full request."""
        from elizaos_plugin_acp.types import DiscountsRequest

        request = CreateCheckoutSessionRequest(
            buyer=Buyer(
                email="buyer@example.com",
                first_name="Jane",
                last_name="Doe",
            ),
            line_items=[Item(id="item_123", name="Widget", quantity=2, unit_amount=999)],
            currency="USD",
            fulfillment_details=FulfillmentDetails(
                name="Jane Doe",
                email="jane@example.com",
                address=Address(
                    name="Jane Doe",
                    line_one="456 Oak Ave",
                    city="New York",
                    state="NY",
                    country="US",
                    postal_code="10001",
                ),
            ),
            discounts=DiscountsRequest(codes=["WELCOME10"]),
            locale="en-US",
            timezone="America/New_York",
            metadata={
                "source": "elizaos",
                "room_id": "room_123",
            },
        )

        assert request.buyer is not None
        assert request.buyer.email == "buyer@example.com"
        assert request.discounts is not None
        assert request.discounts.codes is not None
        assert "WELCOME10" in request.discounts.codes
