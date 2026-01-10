//! Integration tests for OpenAI plugin against live API.
//!
//! These tests require a valid OPENAI_API_KEY environment variable.

use elizaos_plugin_openai::{
    count_tokens, detokenize, tokenize, truncate_to_token_limit, EmbeddingParams,
    ImageDescriptionParams, OpenAIClient, OpenAIConfig, TextGenerationParams, TextToSpeechParams,
};

fn get_config() -> Option<OpenAIConfig> {
    dotenvy::dotenv().ok();
    std::env::var("OPENAI_API_KEY")
        .ok()
        .map(|key| OpenAIConfig::new(key))
}

mod text_generation {
    use super::*;

    #[tokio::test]
    async fn test_generate_text() {
        let Some(config) = get_config() else {
            eprintln!("Skipping test: OPENAI_API_KEY not set");
            return;
        };

        let client = OpenAIClient::new(config).expect("Failed to create client");
        let params =
            TextGenerationParams::new("Say hello in exactly 3 words.").temperature(0.0);

        let response = client.generate_text(&params).await.expect("Failed to generate text");

        assert!(!response.is_empty());
        // Check it's approximately 3 words
        let words: Vec<&str> = response.trim().split_whitespace().collect();
        assert!(words.len() <= 10, "Response too long: {}", response);
    }

    #[tokio::test]
    async fn test_generate_text_with_system() {
        let Some(config) = get_config() else {
            eprintln!("Skipping test: OPENAI_API_KEY not set");
            return;
        };

        let client = OpenAIClient::new(config).expect("Failed to create client");
        let params = TextGenerationParams::new("What is 2 + 2?")
            .system("You are a math teacher. Answer with just the number.")
            .temperature(0.0);

        let response = client.generate_text(&params).await.expect("Failed to generate text");

        assert!(response.contains('4'), "Response should contain '4': {}", response);
    }
}

mod embeddings {
    use super::*;

    #[tokio::test]
    async fn test_create_embedding() {
        let Some(config) = get_config() else {
            eprintln!("Skipping test: OPENAI_API_KEY not set");
            return;
        };

        let client = OpenAIClient::new(config).expect("Failed to create client");
        let params = EmbeddingParams::new("Hello, world!");

        let embedding = client.create_embedding(&params).await.expect("Failed to create embedding");

        assert_eq!(embedding.len(), 1536, "Default embedding should be 1536 dimensions");
        assert!(embedding.iter().all(|&x| x.is_finite()), "All values should be finite");
    }

    #[tokio::test]
    async fn test_embedding_consistency() {
        let Some(config) = get_config() else {
            eprintln!("Skipping test: OPENAI_API_KEY not set");
            return;
        };

        let client = OpenAIClient::new(config).expect("Failed to create client");
        let text = "Test embedding consistency";

        let params1 = EmbeddingParams::new(text);
        let params2 = EmbeddingParams::new(text);

        let embedding1 = client.create_embedding(&params1).await.expect("Failed to create embedding 1");
        let embedding2 = client.create_embedding(&params2).await.expect("Failed to create embedding 2");

        // Calculate cosine similarity
        let dot_product: f32 = embedding1.iter().zip(&embedding2).map(|(a, b)| a * b).sum();
        let norm1: f32 = embedding1.iter().map(|x| x * x).sum::<f32>().sqrt();
        let norm2: f32 = embedding2.iter().map(|x| x * x).sum::<f32>().sqrt();
        let cosine_similarity = dot_product / (norm1 * norm2);

        assert!(
            cosine_similarity > 0.99,
            "Embeddings should be nearly identical, got similarity: {}",
            cosine_similarity
        );
    }
}

mod tokenization {
    use super::*;

    #[test]
    fn test_tokenize_detokenize_roundtrip() {
        let original = "Hello, this is a test!";

        let tokens = tokenize(original, "gpt-5").expect("Failed to tokenize");
        assert!(!tokens.is_empty());

        let decoded = detokenize(&tokens, "gpt-5").expect("Failed to detokenize");
        assert_eq!(decoded, original);
    }

    #[test]
    fn test_count_tokens() {
        let text = "Hello world";
        let count = count_tokens(text, "gpt-5").expect("Failed to count tokens");

        assert!(count > 0);
        assert!(count < 10);
    }

    #[test]
    fn test_truncate_to_tokens() {
        let text = "This is a longer piece of text that should be truncated.";
        let truncated =
            truncate_to_token_limit(text, 5, "gpt-5").expect("Failed to truncate");

        let truncated_count = count_tokens(&truncated, "gpt-5").expect("Failed to count");
        assert!(truncated_count <= 5);
    }
}

mod image_description {
    use super::*;

    #[tokio::test]
    async fn test_describe_image() {
        let Some(config) = get_config() else {
            eprintln!("Skipping test: OPENAI_API_KEY not set");
            return;
        };

        let client = OpenAIClient::new(config).expect("Failed to create client");
        // Use a more reliable image URL that OpenAI can access
        let params = ImageDescriptionParams::new(
            "https://images.unsplash.com/photo-1518791841217-8f162f1e1131?w=400"
        );

        let result = client.describe_image(&params).await.expect("Failed to describe image");

        assert!(!result.title.is_empty());
        assert!(!result.description.is_empty());
    }
}

mod structured_output {
    use super::*;

    #[tokio::test]
    async fn test_generate_object() {
        let Some(config) = get_config() else {
            eprintln!("Skipping test: OPENAI_API_KEY not set");
            return;
        };

        let client = OpenAIClient::new(config).expect("Failed to create client");

        let result = client
            .generate_object(
                "Return a JSON object with fields: name (string), age (number), active (boolean). Use values: name='Test', age=25, active=true",
                Some(0.0),
            )
            .await
            .expect("Failed to generate object");

        assert!(result.is_object());
        let obj = result.as_object().unwrap();

        // Check that at least one expected field exists (case-insensitive check)
        let has_name = obj.contains_key("name") || obj.contains_key("Name");
        let has_age = obj.contains_key("age") || obj.contains_key("Age");

        assert!(has_name || has_age, "Should have name or age field: {:?}", result);
    }
}

mod audio {
    use super::*;

    #[tokio::test]
    async fn test_text_to_speech() {
        let Some(config) = get_config() else {
            eprintln!("Skipping test: OPENAI_API_KEY not set");
            return;
        };

        let client = OpenAIClient::new(config).expect("Failed to create client");
        let params = TextToSpeechParams::new("Hello, this is a test.");

        let audio_data = client.text_to_speech(&params).await.expect("Failed to generate speech");

        assert!(!audio_data.is_empty());
        // MP3 files can start with ID3 tag, or with frame sync (0xFF 0xFB or 0xFF 0xFA or 0xFF 0xF3)
        // Check that we got some audio data (at least 1KB for a short phrase)
        assert!(
            audio_data.len() > 1000,
            "Audio data should be at least 1KB, got {} bytes",
            audio_data.len()
        );
        // Check for common MP3 signatures
        let is_valid_mp3 = audio_data.starts_with(b"ID3") 
            || (audio_data.len() >= 2 && audio_data[0] == 0xFF && (audio_data[1] & 0xE0) == 0xE0);
        assert!(is_valid_mp3, "Should be valid MP3 audio data");
    }

    #[tokio::test]
    async fn test_transcription() {
        let Some(config) = get_config() else {
            eprintln!("Skipping test: OPENAI_API_KEY not set");
            return;
        };

        let client = OpenAIClient::new(config).expect("Failed to create client");

        // First, generate some audio using TTS that we'll then transcribe
        // This ensures we have a valid audio format
        let tts_params = TextToSpeechParams::new("Hello, this is a test for transcription.");
        let audio_data = client.text_to_speech(&tts_params).await.expect("Failed to generate TTS");

        let params = elizaos_plugin_openai::TranscriptionParams::default();

        // Use .mp3 extension since TTS returns MP3
        let transcription = client
            .transcribe_audio(audio_data, &params, "audio.mp3")
            .await
            .expect("Failed to transcribe");

        assert!(!transcription.is_empty());
        // The audio says "Hello, this is a test for transcription."
        let lower = transcription.to_lowercase();
        assert!(
            lower.contains("hello") || lower.contains("test") || lower.contains("transcription"),
            "Transcription should contain expected words: {}",
            transcription
        );
    }
}
