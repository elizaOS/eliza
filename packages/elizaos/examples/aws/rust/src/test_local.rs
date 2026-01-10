//! Local test runner for the Rust Lambda handler
//!
//! Run with: cargo run --bin test_local

use eliza_lambda::function_handler;
use lambda_http::{http::Method, Body, Request};
use std::env;
use std::time::Instant;

fn load_env() {
    // Try loading .env from various locations
    let paths = vec![".env", "../.env", "../../.env", "../../../.env"];

    for path in paths {
        if std::path::Path::new(path).exists() {
            if dotenvy::from_path(path).is_ok() {
                println!("📁 Loaded .env from {}", path);
                break;
            }
        }
    }
}

fn create_request(method: Method, path: &str, body: Option<&str>) -> Request {
    let mut builder = lambda_http::http::Request::builder();
    builder = builder.method(method).uri(path);

    if let Some(b) = body {
        builder
            .header("content-type", "application/json")
            .body(Body::Text(b.to_string()))
            .unwrap()
    } else {
        builder.body(Body::Empty).unwrap()
    }
}

#[tokio::main]
async fn main() {
    load_env();

    if env::var("OPENAI_API_KEY").is_err() {
        eprintln!("❌ OPENAI_API_KEY environment variable is required");
        eprintln!("   Set it with: export OPENAI_API_KEY='your-key-here'");
        eprintln!("   Or create a .env file in the project root");
        std::process::exit(1);
    }

    println!("🧪 Testing elizaOS AWS Lambda Handler (Rust)\n");

    // Test 1: Health check
    println!("1️⃣  Testing health check...");
    let request = create_request(Method::GET, "/health", None);
    let response = function_handler(request).await.unwrap();
    println!("   Status: {}", response.status());

    let body = match response.body() {
        Body::Text(t) => t.clone(),
        _ => String::new(),
    };
    println!("   Body: {}", body);
    assert_eq!(response.status(), 200, "Health check failed");
    println!("   ✅ Health check passed\n");

    // Test 2: Chat message
    println!("2️⃣  Testing chat endpoint...");
    let start = Instant::now();
    let request = create_request(
        Method::POST,
        "/chat",
        Some(r#"{"message": "Hello! What's 2 + 2?"}"#),
    );
    let response = function_handler(request).await.unwrap();
    let duration = start.elapsed().as_millis();

    println!("   Status: {}", response.status());
    println!("   Duration: {}ms", duration);
    assert_eq!(response.status(), 200, "Chat failed");

    let body = match response.body() {
        Body::Text(t) => t.clone(),
        _ => String::new(),
    };
    let chat_response: serde_json::Value = serde_json::from_str(&body).unwrap();
    let response_text = chat_response["response"].as_str().unwrap_or("");
    let conv_id = chat_response["conversationId"].as_str().unwrap_or("");
    println!(
        "   Response: {}...",
        &response_text[..response_text.len().min(100)]
    );
    println!("   Conversation ID: {}", conv_id);
    println!("   ✅ Chat endpoint passed\n");

    // Test 3: Conversation continuity
    println!("3️⃣  Testing conversation continuity...");
    let request = create_request(
        Method::POST,
        "/chat",
        Some(&format!(
            r#"{{"message": "What was my previous question?", "conversationId": "{}"}}"#,
            conv_id
        )),
    );
    let response = function_handler(request).await.unwrap();
    assert_eq!(response.status(), 200, "Follow-up failed");

    let body = match response.body() {
        Body::Text(t) => t.clone(),
        _ => String::new(),
    };
    let followup_response: serde_json::Value = serde_json::from_str(&body).unwrap();
    let response_text = followup_response["response"].as_str().unwrap_or("");
    println!(
        "   Response: {}...",
        &response_text[..response_text.len().min(100)]
    );
    println!("   ✅ Conversation continuity passed\n");

    // Test 4: Validation
    println!("4️⃣  Testing validation (empty message)...");
    let request = create_request(Method::POST, "/chat", Some(r#"{"message": ""}"#));
    let response = function_handler(request).await.unwrap();
    println!("   Status: {}", response.status());
    assert_eq!(response.status(), 400, "Validation test failed");
    println!("   ✅ Validation passed\n");

    // Test 5: 404
    println!("5️⃣  Testing 404 response...");
    let request = create_request(Method::GET, "/unknown", None);
    let response = function_handler(request).await.unwrap();
    println!("   Status: {}", response.status());
    assert_eq!(response.status(), 404, "404 test failed");
    println!("   ✅ 404 handling passed\n");

    println!("🎉 All tests passed!");
}
