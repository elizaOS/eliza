//! Live OpenAI integration tests.
//!
//! These tests require:
//! - OPENAI_API_KEY to be set
//! - RUN_LIVE_TESTS=true to be set
//!
//! Run with: RUN_LIVE_TESTS=true OPENAI_API_KEY=sk-... cargo test --test openai_live

use serde::{Deserialize, Serialize};
use std::env;

#[derive(Debug, Serialize)]
struct Message {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct ResponseMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct Choice {
    index: usize,
    message: ResponseMessage,
    finish_reason: String,
}

#[derive(Debug, Deserialize)]
struct Usage {
    prompt_tokens: u32,
    completion_tokens: u32,
    total_tokens: u32,
}

#[derive(Debug, Deserialize)]
struct OpenAIResponse {
    id: String,
    object: String,
    created: u64,
    model: String,
    choices: Vec<Choice>,
    usage: Usage,
}

#[derive(Debug, Serialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<Message>,
    max_tokens: u32,
    temperature: f32,
}

fn should_skip_live_tests() -> bool {
    env::var("RUN_LIVE_TESTS").ok() != Some("true".to_string())
        || env::var("OPENAI_API_KEY").ok().is_none()
}

async fn call_openai(messages: Vec<Message>, model: &str, max_tokens: u32) -> OpenAIResponse {
    let api_key = env::var("OPENAI_API_KEY").expect("OPENAI_API_KEY not set");

    let client = reqwest::Client::new();
    let request = ChatCompletionRequest {
        model: model.to_string(),
        messages,
        max_tokens,
        temperature: 0.0,
    };

    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&request)
        .send()
        .await
        .expect("Failed to send request");

    if !response.status().is_success() {
        let error = response.text().await.unwrap_or_default();
        panic!("OpenAI API error: {}", error);
    }

    response.json().await.expect("Failed to parse response")
}

#[tokio::test]
async fn test_connect_and_get_response() {
    if should_skip_live_tests() {
        println!("Skipping live test - set RUN_LIVE_TESTS=true and OPENAI_API_KEY");
        return;
    }

    let messages = vec![
        Message {
            role: "system".to_string(),
            content: "You are a helpful assistant. Reply briefly.".to_string(),
        },
        Message {
            role: "user".to_string(),
            content: "Say hello in exactly one word.".to_string(),
        },
    ];

    let response = call_openai(messages, "gpt-4o-mini", 100).await;

    // Verify response structure
    assert!(!response.id.is_empty());
    assert_eq!(response.object, "chat.completion");
    assert!(response.model.contains("gpt-4o-mini"));
    assert_eq!(response.choices.len(), 1);
    assert_eq!(response.choices[0].message.role, "assistant");
    assert!(!response.choices[0].message.content.is_empty());
    assert!(response.usage.prompt_tokens > 0);
    assert!(response.usage.completion_tokens > 0);
    assert!(response.usage.total_tokens > 0);
}

#[tokio::test]
async fn test_multi_turn_conversation() {
    if should_skip_live_tests() {
        println!("Skipping live test - set RUN_LIVE_TESTS=true and OPENAI_API_KEY");
        return;
    }

    let messages = vec![
        Message {
            role: "system".to_string(),
            content: "You are a helpful math tutor. Be brief.".to_string(),
        },
        Message {
            role: "user".to_string(),
            content: "What is 2+2?".to_string(),
        },
        Message {
            role: "assistant".to_string(),
            content: "4".to_string(),
        },
        Message {
            role: "user".to_string(),
            content: "And if you multiply that by 3?".to_string(),
        },
    ];

    let response = call_openai(messages, "gpt-4o-mini", 100).await;

    let content = &response.choices[0].message.content;
    assert!(!content.is_empty());
    // The response should mention 12 (4*3)
    assert!(content.to_lowercase().contains("12"));
}

#[tokio::test]
async fn test_max_tokens_respected() {
    if should_skip_live_tests() {
        println!("Skipping live test - set RUN_LIVE_TESTS=true and OPENAI_API_KEY");
        return;
    }

    let messages = vec![Message {
        role: "user".to_string(),
        content: "Write a very long essay about programming.".to_string(),
    }];

    let response = call_openai(messages, "gpt-4o-mini", 100).await;

    // With max_tokens=100, the response should be limited
    assert!(response.usage.completion_tokens <= 100);
}

#[tokio::test]
async fn test_code_related_queries() {
    if should_skip_live_tests() {
        println!("Skipping live test - set RUN_LIVE_TESTS=true and OPENAI_API_KEY");
        return;
    }

    let messages = vec![
        Message {
            role: "system".to_string(),
            content: "You are a coding assistant. Reply with code only.".to_string(),
        },
        Message {
            role: "user".to_string(),
            content: "Write a Python function that adds two numbers. Only the function, no explanation.".to_string(),
        },
    ];

    let response = call_openai(messages, "gpt-4o-mini", 100).await;

    let content = &response.choices[0].message.content;
    assert!(!content.is_empty());
    // Should contain Python function syntax
    assert!(content.contains("def "));
}

#[tokio::test]
async fn test_valid_token_counts() {
    if should_skip_live_tests() {
        println!("Skipping live test - set RUN_LIVE_TESTS=true and OPENAI_API_KEY");
        return;
    }

    let messages = vec![Message {
        role: "user".to_string(),
        content: "Hi".to_string(),
    }];

    let response = call_openai(messages, "gpt-4o-mini", 100).await;

    let usage = &response.usage;
    assert!(usage.prompt_tokens > 0);
    assert!(usage.completion_tokens > 0);
    assert_eq!(
        usage.total_tokens,
        usage.prompt_tokens + usage.completion_tokens
    );
}
