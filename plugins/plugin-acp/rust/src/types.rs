//! ACP (Agentic Commerce Protocol) Types
//!
//! Based on https://github.com/agentic-commerce-protocol/agentic-commerce-protocol

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Checkout session status
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckoutSessionStatus {
    /// Missing required information
    Incomplete,
    /// Requires fulfillment selection
    NotReadyForPayment,
    /// Requires escalation
    RequiresEscalation,
    /// Authentication required
    AuthenticationRequired,
    /// Ready for payment
    ReadyForPayment,
    /// Pending approval
    PendingApproval,
    /// Payment in progress
    CompleteInProgress,
    /// Order completed
    Completed,
    /// Session canceled
    Canceled,
    /// In progress
    InProgress,
    /// Session expired
    Expired,
}

/// Fulfillment option types
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FulfillmentType {
    /// Standard shipping
    Shipping,
    /// Digital delivery
    Digital,
    /// Store pickup
    Pickup,
    /// Local delivery
    LocalDelivery,
}

/// Message types
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageType {
    /// Informational message
    Info,
    /// Warning message
    Warning,
    /// Error message
    Error,
}

/// Message severity levels
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageSeverity {
    /// Informational
    Info,
    /// Low severity
    Low,
    /// Medium severity
    Medium,
    /// High severity
    High,
    /// Critical severity
    Critical,
}

/// Total line types
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TotalType {
    /// Base amount for items
    ItemsBaseAmount,
    /// Discount on items
    ItemsDiscount,
    /// Subtotal
    Subtotal,
    /// Discount
    Discount,
    /// Fulfillment/shipping
    Fulfillment,
    /// Tax
    Tax,
    /// Fee
    Fee,
    /// Gift wrap
    GiftWrap,
    /// Tip
    Tip,
    /// Store credit
    StoreCredit,
    /// Total
    Total,
}

/// Intent trace reason codes for cancellation
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntentTraceReasonCode {
    /// Too expensive
    PriceSensitivity,
    /// Shipping too expensive
    ShippingCost,
    /// Delivery too slow
    ShippingSpeed,
    /// Product doesn't fit needs
    ProductFit,
    /// Trust/security concerns
    TrustSecurity,
    /// Returns policy concerns
    ReturnsPolicy,
    /// Payment options concerns
    PaymentOptions,
    /// Comparing options
    Comparison,
    /// Not ready now
    TimingDeferred,
    /// Other reason
    Other,
}

/// Physical address for shipping/billing
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Address {
    /// Recipient name
    pub name: String,
    /// Street address line 1
    pub line_one: String,
    /// Street address line 2
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_two: Option<String>,
    /// City
    pub city: String,
    /// State/province
    pub state: String,
    /// Country code
    pub country: String,
    /// Postal code
    pub postal_code: String,
}

/// Item to add to cart (request format)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Item {
    /// Item ID
    pub id: String,
    /// Item name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Unit amount in minor units (cents)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit_amount: Option<i64>,
    /// Quantity
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantity: Option<i32>,
}

/// Tax breakdown item
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaxBreakdownItem {
    /// Jurisdiction
    pub jurisdiction: String,
    /// Tax rate
    pub rate: f64,
    /// Tax amount in minor units
    pub amount: i64,
}

/// Total line (subtotal, tax, discount, etc.)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Total {
    /// Total type
    #[serde(rename = "type")]
    pub total_type: TotalType,
    /// Display text
    pub display_text: String,
    /// Amount in minor units
    pub amount: i64,
    /// Presentment amount
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presentment_amount: Option<i64>,
    /// Description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Tax breakdown
    #[serde(skip_serializing_if = "Option::is_none")]
    pub breakdown: Option<Vec<TaxBreakdownItem>>,
}

/// Line item in checkout session (response format)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineItem {
    /// Line item ID
    pub id: String,
    /// Item details
    pub item: Item,
    /// Quantity
    pub quantity: i32,
    /// Item name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Images
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<String>>,
    /// Unit amount
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit_amount: Option<i64>,
    /// Product ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub product_id: Option<String>,
    /// SKU
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sku: Option<String>,
    /// Availability status
    #[serde(skip_serializing_if = "Option::is_none")]
    pub availability_status: Option<String>,
    /// Line item totals
    #[serde(skip_serializing_if = "Option::is_none")]
    pub totals: Option<Vec<Total>>,
}

/// Fulfillment details (recipient information)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FulfillmentDetails {
    /// Recipient name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Phone number
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone_number: Option<String>,
    /// Email
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Address
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<Address>,
}

/// Shipping fulfillment option
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FulfillmentOptionShipping {
    /// Option type
    #[serde(rename = "type")]
    pub option_type: String,
    /// Option ID
    pub id: String,
    /// Title
    pub title: String,
    /// Description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Carrier
    #[serde(skip_serializing_if = "Option::is_none")]
    pub carrier: Option<String>,
    /// Earliest delivery time
    #[serde(skip_serializing_if = "Option::is_none")]
    pub earliest_delivery_time: Option<String>,
    /// Latest delivery time
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_delivery_time: Option<String>,
    /// Totals
    pub totals: Vec<Total>,
}

/// Fulfillment option (union type)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FulfillmentOption {
    /// Shipping option
    Shipping(FulfillmentOptionShipping),
}

/// Selected fulfillment option
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectedFulfillmentOption {
    /// Fulfillment type
    #[serde(rename = "type")]
    pub fulfillment_type: FulfillmentType,
    /// Option ID
    pub option_id: String,
    /// Item IDs
    pub item_ids: Vec<String>,
}

/// Buyer information
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Buyer {
    /// Email (required)
    pub email: String,
    /// First name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_name: Option<String>,
    /// Last name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_name: Option<String>,
    /// Full name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_name: Option<String>,
    /// Phone number
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone_number: Option<String>,
    /// Customer ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub customer_id: Option<String>,
}

/// Payment handler configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentHandler {
    /// Handler ID
    pub id: String,
    /// Handler name
    pub name: String,
    /// Version
    pub version: String,
    /// Spec URL
    pub spec: String,
    /// Requires delegate payment
    pub requires_delegate_payment: bool,
    /// Requires PCI compliance
    pub requires_pci_compliance: bool,
    /// PSP
    pub psp: String,
    /// Config schema URL
    pub config_schema: String,
    /// Instrument schemas
    pub instrument_schemas: Vec<String>,
    /// Configuration
    pub config: HashMap<String, serde_json::Value>,
}

/// Payment configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Payment {
    /// Available handlers
    pub handlers: Vec<PaymentHandler>,
}

/// Capabilities object
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Capabilities {
    /// Payment capabilities
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment: Option<Payment>,
    /// Extensions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<Vec<String>>,
}

/// Message in checkout session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    /// Message type
    #[serde(rename = "type")]
    pub message_type: MessageType,
    /// Code
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// Severity
    #[serde(skip_serializing_if = "Option::is_none")]
    pub severity: Option<MessageSeverity>,
    /// Parameter path
    #[serde(skip_serializing_if = "Option::is_none")]
    pub param: Option<String>,
    /// Content type
    pub content_type: String,
    /// Content
    pub content: String,
}

/// Link in checkout session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Link {
    /// Link type
    #[serde(rename = "type")]
    pub link_type: String,
    /// Title
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// URL
    pub url: String,
}

/// Protocol version metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtocolVersion {
    /// Version string
    pub version: String,
}

/// Coupon details
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Coupon {
    /// Coupon ID
    pub id: String,
    /// Coupon name
    pub name: String,
    /// Percent off
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent_off: Option<f64>,
    /// Amount off
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount_off: Option<i64>,
    /// Currency
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
}

/// Discount allocation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscountAllocation {
    /// JSONPath to target
    pub path: String,
    /// Amount allocated
    pub amount: i64,
}

/// Applied discount
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppliedDiscount {
    /// Discount ID
    pub id: String,
    /// Discount code
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// Coupon details
    pub coupon: Coupon,
    /// Total discount amount
    pub amount: i64,
    /// Automatic discount
    #[serde(skip_serializing_if = "Option::is_none")]
    pub automatic: Option<bool>,
    /// Allocations
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allocations: Option<Vec<DiscountAllocation>>,
}

/// Discounts in response
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DiscountsResponse {
    /// Submitted codes
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codes: Option<Vec<String>>,
    /// Applied discounts
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied: Option<Vec<AppliedDiscount>>,
}

/// Discounts in request
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DiscountsRequest {
    /// Discount codes to apply
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codes: Option<Vec<String>>,
}

/// Estimated delivery window
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EstimatedDelivery {
    /// Earliest delivery
    pub earliest: String,
    /// Latest delivery
    pub latest: String,
}

/// Order confirmation details
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OrderConfirmation {
    /// Confirmation number
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmation_number: Option<String>,
    /// Email sent
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmation_email_sent: Option<bool>,
    /// Receipt URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt_url: Option<String>,
}

/// Support information
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SupportInfo {
    /// Support email
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Support phone
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
}

/// Order object (returned after completion)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    /// Order ID
    pub id: String,
    /// Checkout session ID
    pub checkout_session_id: String,
    /// Order number
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order_number: Option<String>,
    /// Permalink URL
    pub permalink_url: String,
    /// Status
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Estimated delivery
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_delivery: Option<EstimatedDelivery>,
    /// Confirmation
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmation: Option<OrderConfirmation>,
    /// Support info
    #[serde(skip_serializing_if = "Option::is_none")]
    pub support: Option<SupportInfo>,
}

/// Payment credential
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentCredential {
    /// Credential type
    #[serde(rename = "type")]
    pub credential_type: String,
    /// Token
    pub token: String,
}

/// Payment instrument
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentInstrument {
    /// Instrument type
    #[serde(rename = "type")]
    pub instrument_type: String,
    /// Credential
    pub credential: PaymentCredential,
}

/// Payment data for completing checkout
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PaymentData {
    /// Handler ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handler_id: Option<String>,
    /// Instrument
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instrument: Option<PaymentInstrument>,
    /// Billing address
    #[serde(skip_serializing_if = "Option::is_none")]
    pub billing_address: Option<Address>,
    /// Purchase order number
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purchase_order_number: Option<String>,
}

/// Intent trace for cancellation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntentTrace {
    /// Reason code
    pub reason_code: IntentTraceReasonCode,
    /// Summary
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_summary: Option<String>,
    /// Metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, serde_json::Value>>,
}

/// Checkout session (response)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckoutSession {
    /// Session ID
    pub id: String,
    /// Protocol version
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<ProtocolVersion>,
    /// Capabilities
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Capabilities>,
    /// Buyer info
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buyer: Option<Buyer>,
    /// Status
    pub status: CheckoutSessionStatus,
    /// Currency
    pub currency: String,
    /// Line items
    pub line_items: Vec<LineItem>,
    /// Fulfillment details
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fulfillment_details: Option<FulfillmentDetails>,
    /// Fulfillment options
    pub fulfillment_options: Vec<FulfillmentOption>,
    /// Selected fulfillment options
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_fulfillment_options: Option<Vec<SelectedFulfillmentOption>>,
    /// Totals
    pub totals: Vec<Total>,
    /// Messages
    pub messages: Vec<Message>,
    /// Links
    pub links: Vec<Link>,
    /// Created at
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// Updated at
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// Expires at
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    /// Continue URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continue_url: Option<String>,
    /// Metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, serde_json::Value>>,
    /// Discounts
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discounts: Option<DiscountsResponse>,
    /// Order (after completion)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<Order>,
}

/// Create checkout session request
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CreateCheckoutSessionRequest {
    /// Buyer info
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buyer: Option<Buyer>,
    /// Line items
    pub line_items: Vec<Item>,
    /// Currency
    pub currency: String,
    /// Fulfillment details
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fulfillment_details: Option<FulfillmentDetails>,
    /// Capabilities
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Capabilities>,
    /// Discounts
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discounts: Option<DiscountsRequest>,
    /// Locale
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    /// Timezone
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    /// Metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, serde_json::Value>>,
}

/// Update checkout session request
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateCheckoutSessionRequest {
    /// Buyer info
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buyer: Option<Buyer>,
    /// Line items
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_items: Option<Vec<Item>>,
    /// Fulfillment details
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fulfillment_details: Option<FulfillmentDetails>,
    /// Selected fulfillment options
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_fulfillment_options: Option<Vec<SelectedFulfillmentOption>>,
    /// Discounts
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discounts: Option<DiscountsRequest>,
}

/// Complete checkout session request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompleteCheckoutSessionRequest {
    /// Buyer info
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buyer: Option<Buyer>,
    /// Payment data
    pub payment_data: PaymentData,
}

/// Cancel checkout session request
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CancelCheckoutSessionRequest {
    /// Intent trace
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent_trace: Option<IntentTrace>,
}

/// ACP error response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpErrorResponse {
    /// Error type
    #[serde(rename = "type")]
    pub error_type: String,
    /// Error code
    pub code: String,
    /// Error message
    pub message: String,
    /// Parameter path
    #[serde(skip_serializing_if = "Option::is_none")]
    pub param: Option<String>,
}
