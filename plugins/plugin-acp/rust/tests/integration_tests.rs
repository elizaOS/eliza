//! Integration tests for ACP plugin
//!
//! These tests verify the client, actions, and providers work correctly.
//! Uses mockito for HTTP mocking.

use serde_json::json;

/// Create a test checkout session response
fn create_test_session_response(id: &str) -> serde_json::Value {
    json!({
        "id": id,
        "status": "incomplete",
        "currency": "USD",
        "line_items": [{
            "id": "li_1",
            "item": {
                "id": "item_123",
                "name": "Test Product",
                "unit_amount": 1000
            },
            "quantity": 1,
            "name": "Test Product",
            "unit_amount": 1000
        }],
        "fulfillment_options": [],
        "totals": [{
            "type": "items_base_amount",
            "display_text": "Items",
            "amount": 1000
        }, {
            "type": "total",
            "display_text": "Total",
            "amount": 1000
        }],
        "messages": [],
        "links": []
    })
}

/// Create a completed session response with order
fn create_completed_session_response(id: &str) -> serde_json::Value {
    json!({
        "id": id,
        "status": "completed",
        "currency": "USD",
        "line_items": [{
            "id": "li_1",
            "item": {
                "id": "item_123",
                "name": "Test Product",
                "unit_amount": 1000
            },
            "quantity": 1,
            "name": "Test Product",
            "unit_amount": 1000
        }],
        "fulfillment_options": [],
        "totals": [{
            "type": "total",
            "display_text": "Total",
            "amount": 1000
        }],
        "messages": [],
        "links": [],
        "order": {
            "id": "order_abc123",
            "checkout_session_id": id,
            "order_number": "ORD-12345",
            "permalink_url": "https://merchant.com/orders/ORD-12345"
        }
    })
}

/// Create an error response
fn create_error_response(code: &str, message: &str) -> serde_json::Value {
    json!({
        "type": "invalid_request_error",
        "code": code,
        "message": message
    })
}

mod client_tests {
    use elizaos_plugin_acp::*;
    use mockito::{Matcher, Server};
    use serde_json::json;
    use super::{create_test_session_response, create_completed_session_response, create_error_response};

    #[tokio::test]
    async fn test_create_checkout_session_success() {
        let mut server = Server::new_async().await;
        
        let mock = server
            .mock("POST", "/checkout_sessions")
            .with_status(201)
            .with_header("content-type", "application/json")
            .with_body(create_test_session_response("cs_test_123").to_string())
            .match_header("Agentic-Version", Matcher::Any)
            .match_header("Idempotency-Key", Matcher::Any)
            .create_async()
            .await;

        let config = AcpClientConfig::new(server.url());
        let client = AcpClient::new(config).unwrap();

        let request = CreateCheckoutSessionRequest {
            currency: "USD".to_string(),
            line_items: vec![Item {
                id: "item_123".to_string(),
                name: Some("Test Product".to_string()),
                unit_amount: Some(1000),
                quantity: Some(1),
            }],
            ..Default::default()
        };

        let result = client.create_checkout_session(request, None).await;
        assert!(result.is_ok());

        let session = result.unwrap();
        assert_eq!(session.id, "cs_test_123");
        assert_eq!(session.currency, "USD");
        assert!(matches!(session.status, CheckoutSessionStatus::Incomplete));

        mock.assert_async().await;
    }

    #[tokio::test]
    async fn test_get_checkout_session_success() {
        let mut server = Server::new_async().await;
        
        let mock = server
            .mock("GET", "/checkout_sessions/cs_test_123")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(create_test_session_response("cs_test_123").to_string())
            .create_async()
            .await;

        let config = AcpClientConfig::new(server.url());
        let client = AcpClient::new(config).unwrap();

        let result = client.get_checkout_session("cs_test_123").await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().id, "cs_test_123");

        mock.assert_async().await;
    }

    #[tokio::test]
    async fn test_get_checkout_session_not_found() {
        let mut server = Server::new_async().await;
        
        let mock = server
            .mock("GET", "/checkout_sessions/cs_nonexistent")
            .with_status(404)
            .with_header("content-type", "application/json")
            .with_body(create_error_response("resource_not_found", "Checkout session not found").to_string())
            .create_async()
            .await;

        let config = AcpClientConfig::new(server.url());
        let client = AcpClient::new(config).unwrap();

        let result = client.get_checkout_session("cs_nonexistent").await;
        assert!(result.is_err());

        let error = result.unwrap_err();
        assert_eq!(error.status_code(), Some(404));

        mock.assert_async().await;
    }

    #[tokio::test]
    async fn test_update_checkout_session_success() {
        let mut server = Server::new_async().await;
        
        let mock = server
            .mock("POST", "/checkout_sessions/cs_test_123")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(create_test_session_response("cs_test_123").to_string())
            .match_header("Idempotency-Key", Matcher::Any)
            .create_async()
            .await;

        let config = AcpClientConfig::new(server.url());
        let client = AcpClient::new(config).unwrap();

        let request = UpdateCheckoutSessionRequest {
            buyer: Some(Buyer {
                email: "test@example.com".to_string(),
                ..Default::default()
            }),
            ..Default::default()
        };

        let result = client.update_checkout_session("cs_test_123", request, None).await;
        assert!(result.is_ok());

        mock.assert_async().await;
    }

    #[tokio::test]
    async fn test_complete_checkout_session_success() {
        let mut server = Server::new_async().await;
        
        let mock = server
            .mock("POST", "/checkout_sessions/cs_test_123/complete")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(create_completed_session_response("cs_test_123").to_string())
            .match_header("Idempotency-Key", Matcher::Any)
            .create_async()
            .await;

        let config = AcpClientConfig::new(server.url());
        let client = AcpClient::new(config).unwrap();

        let request = CompleteCheckoutSessionRequest {
            buyer: None,
            payment_data: PaymentData {
                handler_id: Some("stripe".to_string()),
                instrument: Some(PaymentInstrument {
                    instrument_type: "card".to_string(),
                    credential: PaymentCredential {
                        credential_type: "token".to_string(),
                        token: "tok_visa".to_string(),
                    },
                }),
                ..Default::default()
            },
        };

        let result = client.complete_checkout_session("cs_test_123", request, None).await;
        assert!(result.is_ok());

        let session = result.unwrap();
        assert!(matches!(session.status, CheckoutSessionStatus::Completed));
        assert!(session.order.is_some());
        assert_eq!(session.order.unwrap().id, "order_abc123");

        mock.assert_async().await;
    }

    #[tokio::test]
    async fn test_cancel_checkout_session_success() {
        let mut server = Server::new_async().await;
        
        let canceled_response = json!({
            "id": "cs_test_123",
            "status": "canceled",
            "currency": "USD",
            "line_items": [],
            "fulfillment_options": [],
            "totals": [],
            "messages": [],
            "links": []
        });

        let mock = server
            .mock("POST", "/checkout_sessions/cs_test_123/cancel")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(canceled_response.to_string())
            .match_header("Idempotency-Key", Matcher::Any)
            .create_async()
            .await;

        let config = AcpClientConfig::new(server.url());
        let client = AcpClient::new(config).unwrap();

        let request = CancelCheckoutSessionRequest {
            intent_trace: Some(IntentTrace {
                reason_code: IntentTraceReasonCode::PriceSensitivity,
                trace_summary: Some("Too expensive".to_string()),
                metadata: None,
            }),
        };

        let result = client.cancel_checkout_session("cs_test_123", request, None).await;
        assert!(result.is_ok());

        let session = result.unwrap();
        assert!(matches!(session.status, CheckoutSessionStatus::Canceled));

        mock.assert_async().await;
    }

    #[tokio::test]
    async fn test_client_with_api_key() {
        let mut server = Server::new_async().await;
        
        let mock = server
            .mock("GET", "/checkout_sessions/cs_test_123")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(create_test_session_response("cs_test_123").to_string())
            .match_header("Authorization", "Bearer test_api_key")
            .create_async()
            .await;

        let config = AcpClientConfig::new(server.url())
            .with_api_key("test_api_key");
        let client = AcpClient::new(config).unwrap();

        let result = client.get_checkout_session("cs_test_123").await;
        assert!(result.is_ok());

        mock.assert_async().await;
    }

    #[tokio::test]
    async fn test_idempotency_key() {
        let mut server = Server::new_async().await;
        
        let mock = server
            .mock("POST", "/checkout_sessions")
            .with_status(201)
            .with_header("content-type", "application/json")
            .with_body(create_test_session_response("cs_test_123").to_string())
            .match_header("Idempotency-Key", "custom_idempotency_key")
            .create_async()
            .await;

        let config = AcpClientConfig::new(server.url());
        let client = AcpClient::new(config).unwrap();

        let request = CreateCheckoutSessionRequest {
            currency: "USD".to_string(),
            line_items: vec![Item {
                id: "item_123".to_string(),
                ..Default::default()
            }],
            ..Default::default()
        };

        let result = client
            .create_checkout_session(request, Some("custom_idempotency_key".to_string()))
            .await;
        assert!(result.is_ok());

        mock.assert_async().await;
    }
}

mod error_tests {
    use elizaos_plugin_acp::*;

    #[test]
    fn test_error_is_retryable() {
        // Network errors are retryable
        let network_err = AcpError::NetworkError("connection failed".to_string());
        assert!(network_err.is_retryable());

        // Timeout is retryable
        let timeout_err = AcpError::Timeout;
        assert!(timeout_err.is_retryable());

        // 429 is retryable
        let rate_limit_err = AcpError::api_error(429, "Rate limit exceeded");
        assert!(rate_limit_err.is_retryable());

        // 500 is retryable
        let server_err = AcpError::api_error(500, "Internal server error");
        assert!(server_err.is_retryable());

        // 400 is not retryable
        let bad_request = AcpError::api_error(400, "Bad request");
        assert!(!bad_request.is_retryable());

        // Validation errors are not retryable
        let validation_err = AcpError::ValidationError("invalid input".to_string());
        assert!(!validation_err.is_retryable());
    }

    #[test]
    fn test_error_status_code() {
        let api_err = AcpError::api_error(404, "Not found");
        assert_eq!(api_err.status_code(), Some(404));

        let not_found = AcpError::SessionNotFound("cs_123".to_string());
        assert_eq!(not_found.status_code(), Some(404));

        let invalid = AcpError::InvalidRequest("bad data".to_string());
        assert_eq!(invalid.status_code(), Some(400));

        let network = AcpError::NetworkError("timeout".to_string());
        assert_eq!(network.status_code(), None);
    }
}

mod types_tests {
    use elizaos_plugin_acp::*;
    use serde_json;

    #[test]
    fn test_checkout_session_status_serialization() {
        let status = CheckoutSessionStatus::ReadyForPayment;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, "\"ready_for_payment\"");

        let parsed: CheckoutSessionStatus = serde_json::from_str("\"incomplete\"").unwrap();
        assert!(matches!(parsed, CheckoutSessionStatus::Incomplete));
    }

    #[test]
    fn test_fulfillment_type_serialization() {
        let ft = FulfillmentType::Shipping;
        let json = serde_json::to_string(&ft).unwrap();
        assert_eq!(json, "\"shipping\"");

        let parsed: FulfillmentType = serde_json::from_str("\"digital\"").unwrap();
        assert!(matches!(parsed, FulfillmentType::Digital));
    }

    #[test]
    fn test_intent_trace_reason_code() {
        let reason = IntentTraceReasonCode::ShippingCost;
        let json = serde_json::to_string(&reason).unwrap();
        assert_eq!(json, "\"shipping_cost\"");
    }

    #[test]
    fn test_address_serialization() {
        let address = Address {
            name: "John Doe".to_string(),
            line_one: "123 Main St".to_string(),
            line_two: Some("Apt 4".to_string()),
            city: "Springfield".to_string(),
            state: "IL".to_string(),
            country: "US".to_string(),
            postal_code: "62701".to_string(),
        };

        let json = serde_json::to_string(&address).unwrap();
        assert!(json.contains("\"name\":\"John Doe\""));
        assert!(json.contains("\"line_two\":\"Apt 4\""));

        let parsed: Address = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.name, "John Doe");
        assert_eq!(parsed.line_two, Some("Apt 4".to_string()));
    }

    #[test]
    fn test_create_request_optional_fields() {
        let request = CreateCheckoutSessionRequest {
            currency: "USD".to_string(),
            line_items: vec![Item {
                id: "item_1".to_string(),
                ..Default::default()
            }],
            ..Default::default()
        };

        let json = serde_json::to_string(&request).unwrap();
        
        // Should not contain null optional fields
        assert!(!json.contains("\"buyer\":null"));
        assert!(!json.contains("\"fulfillment_details\":null"));
        
        // Should contain required fields
        assert!(json.contains("\"currency\":\"USD\""));
    }

    #[test]
    fn test_total_type_all_variants() {
        let types = vec![
            (TotalType::ItemsBaseAmount, "items_base_amount"),
            (TotalType::ItemsDiscount, "items_discount"),
            (TotalType::Subtotal, "subtotal"),
            (TotalType::Discount, "discount"),
            (TotalType::Fulfillment, "fulfillment"),
            (TotalType::Tax, "tax"),
            (TotalType::Fee, "fee"),
            (TotalType::GiftWrap, "gift_wrap"),
            (TotalType::Tip, "tip"),
            (TotalType::StoreCredit, "store_credit"),
            (TotalType::Total, "total"),
        ];

        for (variant, expected) in types {
            let json = serde_json::to_string(&variant).unwrap();
            assert_eq!(json, format!("\"{}\"", expected));
        }
    }

    #[test]
    fn test_payment_data_structure() {
        let payment_data = PaymentData {
            handler_id: Some("stripe".to_string()),
            instrument: Some(PaymentInstrument {
                instrument_type: "card".to_string(),
                credential: PaymentCredential {
                    credential_type: "token".to_string(),
                    token: "tok_visa".to_string(),
                },
            }),
            billing_address: Some(Address {
                name: "Jane Doe".to_string(),
                line_one: "456 Oak Ave".to_string(),
                line_two: None,
                city: "Boston".to_string(),
                state: "MA".to_string(),
                country: "US".to_string(),
                postal_code: "02101".to_string(),
            }),
            purchase_order_number: None,
        };

        let json = serde_json::to_string(&payment_data).unwrap();
        assert!(json.contains("\"handler_id\":\"stripe\""));
        assert!(json.contains("\"token\":\"tok_visa\""));
        assert!(json.contains("\"billing_address\""));
    }

    #[test]
    fn test_order_parsing() {
        let json = r#"{
            "id": "order_123",
            "checkout_session_id": "cs_456",
            "order_number": "ORD-789",
            "permalink_url": "https://example.com/order/789",
            "status": "processing",
            "estimated_delivery": {
                "earliest": "2024-02-10",
                "latest": "2024-02-15"
            }
        }"#;

        let order: Order = serde_json::from_str(json).unwrap();
        assert_eq!(order.id, "order_123");
        assert_eq!(order.checkout_session_id, "cs_456");
        assert_eq!(order.order_number, Some("ORD-789".to_string()));
        assert!(order.estimated_delivery.is_some());
    }

    #[test]
    fn test_applied_discount() {
        let discount = AppliedDiscount {
            id: "disc_1".to_string(),
            code: Some("SAVE10".to_string()),
            coupon: Coupon {
                id: "coupon_1".to_string(),
                name: "10% Off".to_string(),
                percent_off: Some(10.0),
                amount_off: None,
                currency: None,
            },
            amount: 100,
            automatic: Some(false),
            allocations: None,
        };

        let json = serde_json::to_string(&discount).unwrap();
        assert!(json.contains("\"code\":\"SAVE10\""));
        assert!(json.contains("\"percent_off\":10.0"));
    }
}

mod provider_tests {
    use elizaos_plugin_acp::*;
    use elizaos_plugin_acp::providers::*;

    #[tokio::test]
    async fn test_checkout_session_cache_operations() {
        let cache = CheckoutSessionCache::new();
        
        // Initially empty
        assert!(cache.is_empty().await);
        assert_eq!(cache.len().await, 0);
        
        // Add sessions
        let session1 = CheckoutSession {
            id: "cs_1".to_string(),
            protocol: None,
            capabilities: None,
            buyer: None,
            status: CheckoutSessionStatus::Incomplete,
            currency: "USD".to_string(),
            line_items: vec![],
            fulfillment_details: None,
            fulfillment_options: vec![],
            selected_fulfillment_options: None,
            totals: vec![],
            messages: vec![],
            links: vec![],
            created_at: None,
            updated_at: None,
            expires_at: None,
            continue_url: None,
            metadata: None,
            discounts: None,
            order: None,
        };
        
        cache.set(session1).await;
        assert_eq!(cache.len().await, 1);
        
        // Retrieve
        let retrieved = cache.get("cs_1").await;
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().id, "cs_1");
        
        // Non-existent
        assert!(cache.get("cs_nonexistent").await.is_none());
        
        // Remove
        let removed = cache.remove("cs_1").await;
        assert!(removed.is_some());
        assert!(cache.is_empty().await);
    }

    #[tokio::test]
    async fn test_checkout_sessions_provider() {
        let cache = CheckoutSessionCache::new();
        let provider = CheckoutSessionsProvider::new(cache.clone());
        let context = ProviderContext::new();
        
        // Empty cache
        let result = provider.get(&context).await.unwrap();
        assert!(result.contains("No active checkout sessions"));
        
        // Add a session
        let session = CheckoutSession {
            id: "cs_test".to_string(),
            protocol: None,
            capabilities: None,
            buyer: Some(Buyer {
                email: "test@example.com".to_string(),
                ..Default::default()
            }),
            status: CheckoutSessionStatus::ReadyForPayment,
            currency: "USD".to_string(),
            line_items: vec![LineItem {
                id: "li_1".to_string(),
                item: Item {
                    id: "item_1".to_string(),
                    name: Some("Widget".to_string()),
                    unit_amount: Some(2500),
                    quantity: Some(2),
                },
                quantity: 2,
                name: Some("Widget".to_string()),
                description: None,
                images: None,
                unit_amount: Some(2500),
                product_id: None,
                sku: None,
                availability_status: None,
                totals: None,
            }],
            fulfillment_details: None,
            fulfillment_options: vec![],
            selected_fulfillment_options: None,
            totals: vec![Total {
                total_type: TotalType::Total,
                display_text: "Total".to_string(),
                amount: 5000,
                presentment_amount: None,
                description: None,
                breakdown: None,
            }],
            messages: vec![],
            links: vec![],
            created_at: None,
            updated_at: None,
            expires_at: None,
            continue_url: None,
            metadata: None,
            discounts: None,
            order: None,
        };
        
        cache.set(session).await;
        
        let result = provider.get(&context).await.unwrap();
        assert!(result.contains("cs_test"));
        assert!(result.contains("ReadyForPayment"));
        assert!(result.contains("USD"));
        assert!(result.contains("test@example.com"));
    }

    #[tokio::test]
    async fn test_acp_config_provider_unconfigured() {
        let provider = AcpConfigProvider::new();
        let context = ProviderContext::new();
        
        let result = provider.get(&context).await.unwrap();
        assert!(result.contains("not set"));
        assert!(result.contains("ACP_MERCHANT_BASE_URL"));
    }

    #[tokio::test]
    async fn test_acp_config_provider_configured() {
        let provider = AcpConfigProvider::new();
        let mut context = ProviderContext::new();
        context.env.insert("ACP_MERCHANT_BASE_URL".to_string(), "https://api.test.com".to_string());
        context.env.insert("ACP_MERCHANT_API_KEY".to_string(), "test_key".to_string());
        
        let result = provider.get(&context).await.unwrap();
        assert!(result.contains("configured"));
        assert!(!result.contains("not set"));
    }
}

mod action_tests {
    use elizaos_plugin_acp::*;
    use elizaos_plugin_acp::actions::*;

    #[tokio::test]
    async fn test_action_validate_missing_config() {
        let action = CreateCheckoutSessionAction::new();
        let context = ActionContext::new();
        
        let result = action.validate(&context).await;
        assert!(result.is_err());
        
        match result.unwrap_err() {
            AcpError::MissingConfig(msg) => {
                assert!(msg.contains("ACP_MERCHANT_BASE_URL"));
            }
            _ => panic!("Expected MissingConfig error"),
        }
    }

    #[tokio::test]
    async fn test_action_validate_with_config() {
        let action = CreateCheckoutSessionAction::new();
        let mut context = ActionContext::new();
        context.set_env("ACP_MERCHANT_BASE_URL", "https://api.test.com");
        
        let result = action.validate(&context).await;
        assert!(result.is_ok());
        assert!(result.unwrap());
    }

    #[test]
    fn test_action_result_success() {
        let result: ActionResult<String> = ActionResult::success("data".to_string(), "Success!");
        
        assert!(result.success);
        assert_eq!(result.data, Some("data".to_string()));
        assert!(result.error.is_none());
        assert_eq!(result.text, "Success!");
    }

    #[test]
    fn test_action_result_failure() {
        let result: ActionResult<String> = ActionResult::failure("Something went wrong");
        
        assert!(!result.success);
        assert!(result.data.is_none());
        assert_eq!(result.error, Some("Something went wrong".to_string()));
        assert_eq!(result.text, "Something went wrong");
    }

    #[test]
    fn test_all_action_names() {
        assert_eq!(CreateCheckoutSessionAction::new().name(), "createCheckoutSession");
        assert_eq!(GetCheckoutSessionAction::new().name(), "getCheckoutSession");
        assert_eq!(UpdateCheckoutSessionAction::new().name(), "updateCheckoutSession");
        assert_eq!(CompleteCheckoutSessionAction::new().name(), "completeCheckoutSession");
        assert_eq!(CancelCheckoutSessionAction::new().name(), "cancelCheckoutSession");
    }

    #[test]
    fn test_action_context() {
        let mut context = ActionContext::new();
        
        assert!(context.get_env("TEST").is_none());
        
        context.set_env("TEST", "value");
        assert_eq!(context.get_env("TEST"), Some(&"value".to_string()));
        
        context.user_id = Some("user_123".to_string());
        assert_eq!(context.user_id, Some("user_123".to_string()));
    }
}
