#![allow(missing_docs)]

use crate::generated::prompts::EXTRACT_EXPERIENCES_TEMPLATE;

pub fn build_extract_experiences_prompt(
    conversation_context: &str,
    existing_experiences: &str,
) -> String {
    EXTRACT_EXPERIENCES_TEMPLATE
        .replace("{{conversation_context}}", conversation_context)
        .replace("{{existing_experiences}}", existing_experiences)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_extract_experiences_prompt() {
        let prompt = build_extract_experiences_prompt("ctx", "none");
        assert!(prompt.contains("ctx"));
        assert!(prompt.contains("none"));
        assert!(!prompt.contains("{{conversation_context}}"));
        assert!(!prompt.contains("{{existing_experiences}}"));
    }
}
