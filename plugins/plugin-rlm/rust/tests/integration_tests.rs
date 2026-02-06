//! Integration tests for the RLM plugin.

use elizaos_plugin_rlm::{
    RLMBackend, RLMConfig, RLMEnvironment, RLMMessage, RLMResult,
};

#[test]
fn test_config_default_values() {
    let config = RLMConfig::default();
    
    assert_eq!(config.backend, RLMBackend::Gemini);
    assert_eq!(config.environment, RLMEnvironment::Local);
    assert_eq!(config.max_iterations, 4);
    assert_eq!(config.max_depth, 1);
    assert!(!config.verbose);
    assert_eq!(config.python_path, "python");
}

#[test]
fn test_config_validation_valid() {
    let config = RLMConfig::default();
    assert!(config.validate().is_ok());
}

#[test]
fn test_config_validation_invalid_max_iterations() {
    let mut config = RLMConfig::default();
    config.max_iterations = 0;
    
    let result = config.validate();
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("max_iterations"));
}

#[test]
fn test_config_validation_invalid_max_depth() {
    let mut config = RLMConfig::default();
    config.max_depth = 0;
    
    let result = config.validate();
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("max_depth"));
}

#[test]
fn test_backend_display() {
    assert_eq!(RLMBackend::OpenAI.to_string(), "openai");
    assert_eq!(RLMBackend::Anthropic.to_string(), "anthropic");
    assert_eq!(RLMBackend::Gemini.to_string(), "gemini");
    assert_eq!(RLMBackend::Groq.to_string(), "groq");
    assert_eq!(RLMBackend::OpenRouter.to_string(), "openrouter");
}

#[test]
fn test_environment_display() {
    assert_eq!(RLMEnvironment::Local.to_string(), "local");
    assert_eq!(RLMEnvironment::Docker.to_string(), "docker");
    assert_eq!(RLMEnvironment::Modal.to_string(), "modal");
    assert_eq!(RLMEnvironment::Prime.to_string(), "prime");
}

#[test]
fn test_rlm_message_user() {
    let msg = RLMMessage::user("Hello, world!");
    assert_eq!(msg.role, "user");
    assert_eq!(msg.content, "Hello, world!");
}

#[test]
fn test_rlm_message_assistant() {
    let msg = RLMMessage::assistant("Hi there!");
    assert_eq!(msg.role, "assistant");
    assert_eq!(msg.content, "Hi there!");
}

#[test]
fn test_rlm_message_system() {
    let msg = RLMMessage::system("You are a helpful assistant.");
    assert_eq!(msg.role, "system");
    assert_eq!(msg.content, "You are a helpful assistant.");
}

#[test]
fn test_stub_result() {
    let result = RLMResult::stub(None);
    
    assert!(result.metadata.stub);
    assert!(result.text.contains("STUB"));
    assert!(result.metadata.error.is_none());
}

#[test]
fn test_stub_result_with_error() {
    let result = RLMResult::stub(Some("Test error".to_string()));
    
    assert!(result.metadata.stub);
    assert!(result.text.contains("STUB"));
    assert_eq!(result.metadata.error, Some("Test error".to_string()));
}

#[test]
fn test_config_serialization() {
    let config = RLMConfig::default();
    let json = serde_json::to_string(&config).unwrap();
    let deserialized: RLMConfig = serde_json::from_str(&json).unwrap();
    
    assert_eq!(config.backend, deserialized.backend);
    assert_eq!(config.environment, deserialized.environment);
    assert_eq!(config.max_iterations, deserialized.max_iterations);
    assert_eq!(config.max_depth, deserialized.max_depth);
    assert_eq!(config.verbose, deserialized.verbose);
}

#[test]
fn test_result_serialization() {
    let result = RLMResult {
        text: "Generated text".to_string(),
        metadata: elizaos_plugin_rlm::RLMMetadata {
            stub: false,
            iterations: Some(3),
            depth: Some(1),
            error: None,
        },
        cost: None,
        trajectory: None,
    };
    
    let json = serde_json::to_string(&result).unwrap();
    let deserialized: RLMResult = serde_json::from_str(&json).unwrap();
    
    assert_eq!(result.text, deserialized.text);
    assert_eq!(result.metadata.stub, deserialized.metadata.stub);
    assert_eq!(result.metadata.iterations, deserialized.metadata.iterations);
    assert!(deserialized.cost.is_none());
    assert!(deserialized.trajectory.is_none());
}

// Async tests for client (require tokio runtime)
#[cfg(test)]
mod async_tests {
    use super::*;
    use elizaos_plugin_rlm::{RLMClient, MessageInput};

    #[tokio::test]
    async fn test_client_creation() {
        let config = RLMConfig::default();
        let result = RLMClient::new(config);
        
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_client_normalize_string() {
        let messages = RLMClient::normalize_messages("Hello".into());
        
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "Hello");
    }

    #[tokio::test]
    async fn test_client_normalize_messages() {
        let input = vec![
            RLMMessage::user("Hello"),
            RLMMessage::assistant("Hi there"),
        ];
        let messages = RLMClient::normalize_messages(input.into());
        
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[1].role, "assistant");
    }

    #[tokio::test]
    async fn test_message_input_from_str() {
        let input: MessageInput = "Hello".into();
        let messages = RLMClient::normalize_messages(input);
        
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "Hello");
    }

    #[tokio::test]
    async fn test_message_input_from_string() {
        let input: MessageInput = String::from("Hello").into();
        let messages = RLMClient::normalize_messages(input);
        
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "Hello");
    }
}

// Tests that require Python (skipped if not available)
#[cfg(test)]
mod python_tests {
    use super::*;
    use std::process::Command;

    fn python_available() -> bool {
        Command::new("python")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[test]
    #[ignore = "Requires Python to be installed"]
    fn test_python_detection() {
        if !python_available() {
            eprintln!("Python not available, skipping test");
            return;
        }
        
        // Python is available
        assert!(python_available());
    }
}
