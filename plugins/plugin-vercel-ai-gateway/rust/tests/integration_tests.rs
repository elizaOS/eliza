use elizaos_plugin_gateway::{
    get_gateway_plugin, GatewayConfig, GatewayPlugin, TextGenerationParams,
};
use futures::StreamExt;

fn get_api_key() -> Option<String> {
    std::env::var("AI_GATEWAY_API_KEY")
        .or_else(|_| std::env::var("AIGATEWAY_API_KEY"))
        .or_else(|_| std::env::var("VERCEL_OIDC_TOKEN"))
        .ok()
}

#[tokio::test]
async fn test_text_generation() {
    let api_key = match get_api_key() {
        Some(key) => key,
        None => {
            eprintln!("Skipping test: API key not available");
            return;
        }
    };

    let config = GatewayConfig::new(&api_key);
    let plugin = GatewayPlugin::new(config).expect("Failed to create plugin");

    let response = plugin
        .generate_text("Say hello in 5 words.")
        .await
        .expect("Failed to generate text");

    assert!(!response.is_empty());
    println!("Generated: {}", response);
}

#[tokio::test]
async fn test_embedding_generation() {
    let api_key = match get_api_key() {
        Some(key) => key,
        None => {
            eprintln!("Skipping test: API key not available");
            return;
        }
    };

    let config = GatewayConfig::new(&api_key);
    let plugin = GatewayPlugin::new(config).expect("Failed to create plugin");

    let embedding = plugin
        .create_embedding("Hello, world!")
        .await
        .expect("Failed to create embedding");

    assert!(!embedding.is_empty());
    println!("Embedding dimensions: {}", embedding.len());
}

#[tokio::test]
async fn test_object_generation() {
    let api_key = match get_api_key() {
        Some(key) => key,
        None => {
            eprintln!("Skipping test: API key not available");
            return;
        }
    };

    let config = GatewayConfig::new(&api_key);
    let plugin = GatewayPlugin::new(config).expect("Failed to create plugin");

    let result = plugin
        .generate_object("Return a JSON object with name (string) and age (number)")
        .await
        .expect("Failed to generate object");

    assert!(result.is_object());
    println!("Generated: {}", result);
}

#[tokio::test]
async fn test_plugin_from_env() {
    if get_api_key().is_none() {
        eprintln!("Skipping test: API key not available");
        return;
    }

    let plugin = get_gateway_plugin().expect("Failed to create plugin from env");
    let response = plugin
        .generate_text("Hi!")
        .await
        .expect("Failed to generate text");

    assert!(!response.is_empty());
}

#[tokio::test]
async fn test_streaming_text_generation() {
    let api_key = match get_api_key() {
        Some(key) => key,
        None => {
            eprintln!("Skipping test: API key not available");
            return;
        }
    };

    let config = GatewayConfig::new(&api_key);
    let plugin = GatewayPlugin::new(config).expect("Failed to create plugin");

    let params = TextGenerationParams::new("Count from 1 to 5, one number per line.");
    let mut stream = Box::pin(
        plugin
            .stream_text(&params)
            .await
            .expect("Failed to start streaming"),
    );

    let mut chunks: Vec<String> = Vec::new();
    let mut full_response = String::new();

    while let Some(chunk) = stream.as_mut().next().await {
        match chunk {
            Ok(text) => {
                chunks.push(text.clone());
                full_response.push_str(&text);
            }
            Err(e) => panic!("Stream error: {}", e),
        }
    }

    assert!(!chunks.is_empty(), "Should receive at least one chunk");
    assert!(
        !full_response.is_empty(),
        "Full response should not be empty"
    );
    println!("Received {} chunks", chunks.len());
    println!("Full response: {}", full_response);
}

#[tokio::test]
async fn test_streaming_simple() {
    let api_key = match get_api_key() {
        Some(key) => key,
        None => {
            eprintln!("Skipping test: API key not available");
            return;
        }
    };

    let config = GatewayConfig::new(&api_key);
    let plugin = GatewayPlugin::new(config).expect("Failed to create plugin");

    let mut stream = Box::pin(
        plugin
            .stream_text_simple("Say hello!")
            .await
            .expect("Failed to start streaming"),
    );

    let mut received_any = false;
    while let Some(chunk) = stream.as_mut().next().await {
        if let Ok(text) = chunk {
            print!("{}", text);
            received_any = true;
        }
    }
    println!();

    assert!(received_any, "Should receive at least one chunk");
}
