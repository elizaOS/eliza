#![allow(missing_docs)]

use crate::error::{OpenAIError, Result};
use tiktoken_rs::{get_bpe_from_model, CoreBPE};

fn get_tokenizer(model: &str) -> Result<CoreBPE> {
    if let Ok(bpe) = get_bpe_from_model(model) {
        return Ok(bpe);
    }
    if model.contains("4o") {
        get_bpe_from_model("gpt-5").map_err(|e| OpenAIError::TokenizerError(e.to_string()))
    } else if model.contains("4") {
        get_bpe_from_model("gpt-4").map_err(|e| OpenAIError::TokenizerError(e.to_string()))
    } else {
        get_bpe_from_model("gpt-3.5-turbo").map_err(|e| OpenAIError::TokenizerError(e.to_string()))
    }
}

pub fn tokenize(text: &str, model: &str) -> Result<Vec<u32>> {
    let bpe = get_tokenizer(model)?;
    Ok(bpe.encode_with_special_tokens(text))
}

pub fn detokenize(tokens: &[u32], model: &str) -> Result<String> {
    let bpe = get_tokenizer(model)?;
    bpe.decode(tokens.to_vec())
        .map_err(|e| OpenAIError::TokenizerError(e.to_string()))
}

pub fn count_tokens(text: &str, model: &str) -> Result<usize> {
    let tokens = tokenize(text, model)?;
    Ok(tokens.len())
}

pub fn truncate_to_token_limit(text: &str, max_tokens: usize, model: &str) -> Result<String> {
    let tokens = tokenize(text, model)?;
    if tokens.len() <= max_tokens {
        return Ok(text.to_string());
    }
    let truncated_tokens = &tokens[..max_tokens];
    detokenize(truncated_tokens, model)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tokenize_roundtrip() {
        let text = "Hello, world!";
        let tokens = tokenize(text, "gpt-5").unwrap();
        assert!(!tokens.is_empty());

        let decoded = detokenize(&tokens, "gpt-5").unwrap();
        assert_eq!(decoded, text);
    }

    #[test]
    fn test_count_tokens() {
        let text = "Hello world";
        let count = count_tokens(text, "gpt-5").unwrap();
        assert!(count > 0);
        assert!(count < 10);
    }

    #[test]
    fn test_truncate() {
        let text = "This is a longer piece of text that should be truncated.";
        let truncated = truncate_to_token_limit(text, 5, "gpt-5").unwrap();
        let truncated_count = count_tokens(&truncated, "gpt-5").unwrap();
        assert!(truncated_count <= 5);
    }
}
