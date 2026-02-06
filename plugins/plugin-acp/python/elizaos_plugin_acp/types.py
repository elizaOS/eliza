"""
ACP (Agentic Commerce Protocol) Types

Based on https://github.com/agentic-commerce-protocol/agentic-commerce-protocol
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class CheckoutSessionStatus(str, Enum):
    """Checkout session status values."""

    INCOMPLETE = "incomplete"
    NOT_READY_FOR_PAYMENT = "not_ready_for_payment"
    REQUIRES_ESCALATION = "requires_escalation"
    AUTHENTICATION_REQUIRED = "authentication_required"
    READY_FOR_PAYMENT = "ready_for_payment"
    PENDING_APPROVAL = "pending_approval"
    COMPLETE_IN_PROGRESS = "complete_in_progress"
    COMPLETED = "completed"
    CANCELED = "canceled"
    IN_PROGRESS = "in_progress"
    EXPIRED = "expired"


class FulfillmentType(str, Enum):
    """Fulfillment option types."""

    SHIPPING = "shipping"
    DIGITAL = "digital"
    PICKUP = "pickup"
    LOCAL_DELIVERY = "local_delivery"


class MessageType(str, Enum):
    """Message types."""

    INFO = "info"
    WARNING = "warning"
    ERROR = "error"


class MessageSeverity(str, Enum):
    """Message severity levels."""

    INFO = "info"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class TotalType(str, Enum):
    """Total line types."""

    ITEMS_BASE_AMOUNT = "items_base_amount"
    ITEMS_DISCOUNT = "items_discount"
    SUBTOTAL = "subtotal"
    DISCOUNT = "discount"
    FULFILLMENT = "fulfillment"
    TAX = "tax"
    FEE = "fee"
    GIFT_WRAP = "gift_wrap"
    TIP = "tip"
    STORE_CREDIT = "store_credit"
    TOTAL = "total"


class IntentTraceReasonCode(str, Enum):
    """Intent trace reason codes for cancellation."""

    PRICE_SENSITIVITY = "price_sensitivity"
    SHIPPING_COST = "shipping_cost"
    SHIPPING_SPEED = "shipping_speed"
    PRODUCT_FIT = "product_fit"
    TRUST_SECURITY = "trust_security"
    RETURNS_POLICY = "returns_policy"
    PAYMENT_OPTIONS = "payment_options"
    COMPARISON = "comparison"
    TIMING_DEFERRED = "timing_deferred"
    OTHER = "other"


class Address(BaseModel):
    """Physical address for shipping/billing."""

    name: str
    line_one: str
    line_two: str | None = None
    city: str
    state: str
    country: str
    postal_code: str


class Item(BaseModel):
    """Item to add to cart (request format)."""

    id: str
    name: str | None = None
    unit_amount: int | None = None
    quantity: int | None = None


class TaxBreakdownItem(BaseModel):
    """Tax breakdown item."""

    jurisdiction: str
    rate: float
    amount: int


class Total(BaseModel):
    """Total line (subtotal, tax, discount, etc.)."""

    type: TotalType
    display_text: str
    amount: int
    presentment_amount: int | None = None
    description: str | None = None
    breakdown: list[TaxBreakdownItem] | None = None


class LineItem(BaseModel):
    """Line item in checkout session (response format)."""

    id: str
    item: Item
    quantity: int
    name: str | None = None
    description: str | None = None
    images: list[str] | None = None
    unit_amount: int | None = None
    product_id: str | None = None
    sku: str | None = None
    variant_id: str | None = None
    category: str | None = None
    tags: list[str] | None = None
    availability_status: (
        Literal["in_stock", "low_stock", "out_of_stock", "backorder", "pre_order"] | None
    ) = None
    available_quantity: int | None = None
    max_quantity_per_order: int | None = None
    totals: list[Total] | None = None


class FulfillmentDetails(BaseModel):
    """Fulfillment details (recipient information)."""

    name: str | None = None
    phone_number: str | None = None
    email: str | None = None
    address: Address | None = None


class FulfillmentOptionBase(BaseModel):
    """Base fulfillment option."""

    id: str
    title: str
    description: str | None = None
    totals: list[Total]


class FulfillmentOptionShipping(FulfillmentOptionBase):
    """Shipping fulfillment option."""

    type: Literal["shipping"] = "shipping"
    carrier: str | None = None
    earliest_delivery_time: str | None = None
    latest_delivery_time: str | None = None


class FulfillmentOptionDigital(FulfillmentOptionBase):
    """Digital fulfillment option."""

    type: Literal["digital"] = "digital"


class PickupLocation(BaseModel):
    """Pickup location details."""

    name: str
    address: Address
    phone: str | None = None
    instructions: str | None = None


class FulfillmentOptionPickup(FulfillmentOptionBase):
    """Pickup fulfillment option."""

    type: Literal["pickup"] = "pickup"
    location: PickupLocation
    pickup_type: Literal["in_store", "curbside", "locker"] | None = None
    ready_by: str | None = None
    pickup_by: str | None = None


class DeliveryWindow(BaseModel):
    """Delivery window."""

    start: str
    end: str


class ServiceArea(BaseModel):
    """Service area for local delivery."""

    radius_miles: float | None = None
    center_postal_code: str | None = None


class FulfillmentOptionLocalDelivery(FulfillmentOptionBase):
    """Local delivery fulfillment option."""

    type: Literal["local_delivery"] = "local_delivery"
    delivery_window: DeliveryWindow | None = None
    service_area: ServiceArea | None = None


FulfillmentOption = (
    FulfillmentOptionShipping
    | FulfillmentOptionDigital
    | FulfillmentOptionPickup
    | FulfillmentOptionLocalDelivery
)


class SelectedFulfillmentOption(BaseModel):
    """Selected fulfillment option."""

    type: FulfillmentType
    option_id: str
    item_ids: list[str]


class Buyer(BaseModel):
    """Buyer information."""

    email: str
    first_name: str | None = None
    last_name: str | None = None
    full_name: str | None = None
    phone_number: str | None = None
    customer_id: str | None = None
    account_type: Literal["guest", "registered", "business"] | None = None
    authentication_status: Literal["authenticated", "guest", "requires_signin"] | None = None


class PaymentHandler(BaseModel):
    """Payment handler configuration."""

    id: str
    name: str
    version: str
    spec: str
    requires_delegate_payment: bool
    requires_pci_compliance: bool
    psp: str
    config_schema: str
    instrument_schemas: list[str]
    config: dict[str, object]


class Payment(BaseModel):
    """Payment configuration."""

    handlers: list[PaymentHandler]


class InterventionCapabilities(BaseModel):
    """Intervention capabilities."""

    supported: list[Literal["3ds", "biometric", "address_verification"]] | None = None
    required: list[Literal["3ds", "biometric"]] | None = None
    enforcement: Literal["always", "conditional", "optional"] | None = None


class Capabilities(BaseModel):
    """Capabilities object."""

    payment: Payment | None = None
    interventions: InterventionCapabilities | None = None
    extensions: list[str] | None = None


class Message(BaseModel):
    """Message in checkout session."""

    type: MessageType
    code: str | None = None
    severity: MessageSeverity | None = None
    param: str | None = None
    content_type: Literal["plain", "markdown"]
    content: str


class Link(BaseModel):
    """Link in checkout session."""

    type: Literal[
        "terms_of_use",
        "privacy_policy",
        "return_policy",
        "shipping_policy",
        "contact_us",
        "about_us",
        "faq",
        "support",
    ]
    title: str | None = None
    url: str


class ProtocolVersion(BaseModel):
    """Protocol version metadata."""

    version: str


class Coupon(BaseModel):
    """Coupon details."""

    id: str
    name: str
    percent_off: float | None = None
    amount_off: int | None = None
    currency: str | None = None
    duration: Literal["once", "repeating", "forever"] | None = None
    duration_in_months: int | None = None
    max_redemptions: int | None = None
    times_redeemed: int | None = None
    metadata: dict[str, str] | None = None


class DiscountAllocation(BaseModel):
    """Discount allocation."""

    path: str
    amount: int


class AppliedDiscount(BaseModel):
    """Applied discount."""

    id: str
    code: str | None = None
    coupon: Coupon
    amount: int
    automatic: bool | None = None
    start: str | None = None
    end: str | None = None
    method: Literal["each", "across"] | None = None
    priority: int | None = None
    allocations: list[DiscountAllocation] | None = None


class DiscountsResponse(BaseModel):
    """Discounts in response."""

    codes: list[str] | None = None
    applied: list[AppliedDiscount] | None = None


class DiscountsRequest(BaseModel):
    """Discounts in request."""

    codes: list[str] | None = None


class EstimatedDelivery(BaseModel):
    """Estimated delivery window."""

    earliest: str
    latest: str


class OrderConfirmation(BaseModel):
    """Order confirmation details."""

    confirmation_number: str | None = None
    confirmation_email_sent: bool | None = None
    receipt_url: str | None = None
    invoice_number: str | None = None


class SupportInfo(BaseModel):
    """Support information."""

    email: str | None = None
    phone: str | None = None
    hours: str | None = None
    help_center_url: str | None = None


class Order(BaseModel):
    """Order object (returned after completion)."""

    id: str
    checkout_session_id: str
    order_number: str | None = None
    permalink_url: str
    status: Literal["confirmed", "processing", "shipped", "delivered"] | None = None
    estimated_delivery: EstimatedDelivery | None = None
    confirmation: OrderConfirmation | None = None
    support: SupportInfo | None = None


class PaymentCredential(BaseModel):
    """Payment credential."""

    type: str
    token: str


class PaymentInstrument(BaseModel):
    """Payment instrument."""

    type: str
    credential: PaymentCredential


class PaymentData(BaseModel):
    """Payment data for completing checkout."""

    handler_id: str | None = None
    instrument: PaymentInstrument | None = None
    billing_address: Address | None = None
    purchase_order_number: str | None = None
    payment_terms: Literal["immediate", "net_15", "net_30", "net_60", "net_90"] | None = None
    due_date: str | None = None
    approval_required: bool | None = None


class AffiliateAttributionSource(BaseModel):
    """Affiliate attribution source."""

    type: Literal["url", "platform", "unknown"]
    url: str | None = None


class AffiliateAttribution(BaseModel):
    """Affiliate attribution for tracking."""

    provider: str
    token: str | None = None
    publisher_id: str | None = None
    campaign_id: str | None = None
    creative_id: str | None = None
    sub_id: str | None = None
    source: AffiliateAttributionSource | None = None
    issued_at: str | None = None
    expires_at: str | None = None
    metadata: dict[str, str | int | bool] | None = None
    touchpoint: Literal["first", "last"] | None = None


class IntentTrace(BaseModel):
    """Intent trace for cancellation."""

    reason_code: IntentTraceReasonCode
    trace_summary: str | None = None
    metadata: dict[str, str | int | bool] | None = None


class CheckoutSession(BaseModel):
    """Checkout session (response)."""

    id: str
    protocol: ProtocolVersion | None = None
    capabilities: Capabilities | None = None
    buyer: Buyer | None = None
    status: CheckoutSessionStatus
    currency: str
    presentment_currency: str | None = None
    exchange_rate: float | None = None
    exchange_rate_timestamp: str | None = None
    locale: str | None = None
    timezone: str | None = None
    line_items: list[LineItem]
    fulfillment_details: FulfillmentDetails | None = None
    fulfillment_options: list[FulfillmentOption]
    selected_fulfillment_options: list[SelectedFulfillmentOption] | None = None
    totals: list[Total]
    messages: list[Message]
    links: list[Link]
    created_at: str | None = None
    updated_at: str | None = None
    expires_at: str | None = None
    continue_url: str | None = None
    metadata: dict[str, object] | None = None
    quote_id: str | None = None
    quote_expires_at: str | None = None
    discounts: DiscountsResponse | None = None
    order: Order | None = None


class CreateCheckoutSessionRequest(BaseModel):
    """Create checkout session request."""

    buyer: Buyer | None = None
    line_items: list[Item]
    currency: str
    fulfillment_details: FulfillmentDetails | None = None
    capabilities: Capabilities | None = None
    affiliate_attribution: AffiliateAttribution | None = None
    discounts: DiscountsRequest | None = None
    locale: str | None = None
    timezone: str | None = None
    quote_id: str | None = None
    metadata: dict[str, object] | None = None


class UpdateCheckoutSessionRequest(BaseModel):
    """Update checkout session request."""

    buyer: Buyer | None = None
    line_items: list[Item] | None = None
    fulfillment_details: FulfillmentDetails | None = None
    selected_fulfillment_options: list[SelectedFulfillmentOption] | None = None
    discounts: DiscountsRequest | None = None


class CompleteCheckoutSessionRequest(BaseModel):
    """Complete checkout session request."""

    buyer: Buyer | None = None
    payment_data: PaymentData
    affiliate_attribution: AffiliateAttribution | None = None


class CancelCheckoutSessionRequest(BaseModel):
    """Cancel checkout session request."""

    intent_trace: IntentTrace | None = None


class AcpError(BaseModel):
    """ACP Error response."""

    type: Literal["invalid_request", "request_not_idempotent", "processing_error", "service_unavailable"]
    code: str
    message: str
    param: str | None = None


class AcpClientConfig(BaseModel):
    """ACP Client configuration."""

    base_url: str
    api_key: str | None = None
    api_version: str = "2026-01-30"
    default_currency: str = "USD"
    timeout: int = 30000
