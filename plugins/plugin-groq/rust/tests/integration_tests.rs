use elizaos_plugin_groq::{GenerateObjectParams, GenerateTextParams, GroqClient};

fn get_client() -> Option<GroqClient> {
    dotenvy::dotenv().ok();
    let api_key = std::env::var("GROQ_API_KEY").ok()?;
    GroqClient::new(api_key, None).ok()
}

#[tokio::test]
#[ignore = "requires GROQ_API_KEY"]
async fn test_generate_text_small() {
    let client = get_client().expect("GROQ_API_KEY not set");

    let response = client
        .generate_text_small(GenerateTextParams {
            prompt: "Say 'hello' and nothing else.".to_string(),
            max_tokens: Some(10),
            ..Default::default()
        })
        .await;

    assert!(response.is_ok(), "Failed: {:?}", response.err());
    let text = response.unwrap();
    assert!(!text.is_empty());
    println!("Response: {}", text);
}

#[tokio::test]
#[ignore = "requires GROQ_API_KEY"]
async fn test_generate_text_large() {
    let client = get_client().expect("GROQ_API_KEY not set");

    let response = client
        .generate_text_large(GenerateTextParams {
            prompt: "What is 2 + 2? Answer with just the number.".to_string(),
            max_tokens: Some(10),
            temperature: Some(0.0),
            ..Default::default()
        })
        .await;

    assert!(response.is_ok(), "Failed: {:?}", response.err());
    let text = response.unwrap();
    assert!(!text.is_empty());
    println!("Response: {}", text);
}

#[tokio::test]
#[ignore = "requires GROQ_API_KEY"]
async fn test_generate_object() {
    let client = get_client().expect("GROQ_API_KEY not set");

    let response = client
        .generate_object(GenerateObjectParams {
            prompt: "Generate a JSON object with a single field 'name' set to 'test'.".to_string(),
            temperature: Some(0.0),
        })
        .await;

    assert!(response.is_ok(), "Failed: {:?}", response.err());
    let obj = response.unwrap();
    println!("Object: {:?}", obj);
}

#[tokio::test]
#[ignore = "requires GROQ_API_KEY"]
async fn test_list_models() {
    let client = get_client().expect("GROQ_API_KEY not set");

    let response = client.list_models().await;

    assert!(response.is_ok(), "Failed: {:?}", response.err());
    let models = response.unwrap();
    assert!(!models.is_empty());
    println!("Available models: {}", models.len());
    for model in &models {
        println!("  - {}", model.id);
    }
}

#[tokio::test]
async fn test_client_invalid_api_key() {
    let client = GroqClient::new("invalid-key", None);
    assert!(client.is_ok());

    let client = client.unwrap();
    let response = client
        .generate_text_small(GenerateTextParams {
            prompt: "test".to_string(),
            ..Default::default()
        })
        .await;

    assert!(response.is_err());
}

#[tokio::test]
async fn test_client_empty_api_key() {
    let client = GroqClient::new("", None);
    assert!(client.is_err());
}
