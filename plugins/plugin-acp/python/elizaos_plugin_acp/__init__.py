"""
@elizaos/plugin-acp - Agentic Commerce Protocol plugin for elizaOS

Enables AI agents to interact with merchants for checkout and commerce.
Based on https://github.com/agentic-commerce-protocol/agentic-commerce-protocol
"""

from elizaos_plugin_acp.plugin import acp_plugin
from elizaos_plugin_acp.client import AcpClient, AcpApiError, create_acp_client_from_env
from elizaos_plugin_acp.types import (
    CheckoutSession,
    CheckoutSessionStatus,
    LineItem,
    Item,
    Total,
    Address,
    Buyer,
    FulfillmentDetails,
    FulfillmentOption,
    SelectedFulfillmentOption,
    PaymentData,
    PaymentHandler,
    Order,
    Coupon,
    AppliedDiscount,
    DiscountsRequest,
    DiscountsResponse,
    IntentTrace,
    AcpError,
    AcpClientConfig,
    CreateCheckoutSessionRequest,
    UpdateCheckoutSessionRequest,
    CompleteCheckoutSessionRequest,
    CancelCheckoutSessionRequest,
)

__all__ = [
    # Plugin
    "acp_plugin",
    # Client
    "AcpClient",
    "AcpApiError",
    "create_acp_client_from_env",
    # Types
    "CheckoutSession",
    "CheckoutSessionStatus",
    "LineItem",
    "Item",
    "Total",
    "Address",
    "Buyer",
    "FulfillmentDetails",
    "FulfillmentOption",
    "SelectedFulfillmentOption",
    "PaymentData",
    "PaymentHandler",
    "Order",
    "Coupon",
    "AppliedDiscount",
    "DiscountsRequest",
    "DiscountsResponse",
    "IntentTrace",
    "AcpError",
    "AcpClientConfig",
    "CreateCheckoutSessionRequest",
    "UpdateCheckoutSessionRequest",
    "CompleteCheckoutSessionRequest",
    "CancelCheckoutSessionRequest",
]

__version__ = "2.0.0"
