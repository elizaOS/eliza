use tracing::{error, info};

use crate::client::TwitterClient;

#[derive(Debug, Clone)]
/// Result returned by the [`PostAction`] handler.
///
/// This is designed to be a small, serializable-ish payload that can be surfaced
/// to an agent and/or logged by the runtime.
pub struct PostActionResult {
    /// Whether the post was created successfully.
    pub success: bool,
    /// Human-readable message describing the outcome.
    pub text: String,
    /// The created post ID (if available).
    pub post_id: Option<String>,
    /// A canonical URL to the created post (if available).
    pub post_url: Option<String>,
    /// Error message (if the action failed).
    pub error: Option<String>,
}

/// Action helper for posting content to X (formerly Twitter).
pub struct PostAction;

impl PostAction {
    /// Action name.
    pub const NAME: &'static str = "POST";

    /// Action description.
    pub const DESCRIPTION: &'static str = "Post content on X (formerly Twitter)";

    /// Similar action names.
    pub const SIMILES: &'static [&'static str] = &[
        "POST_TO_X",
        "POST",
        "SEND_POST",
        "SHARE_ON_X",
        "TWEET",
        "POST_TWEET",
    ];

    /// Maximum allowed character length for an X post.
    pub const MAX_LENGTH: usize = 280;

    /// Validate that a [`TwitterClient`] is authenticated and can post.
    pub fn validate(client: &TwitterClient) -> bool {
        client.is_authenticated()
    }

    /// Truncate input text to fit within [`Self::MAX_LENGTH`].
    ///
    /// Attempts to truncate on sentence boundaries; falls back to a hard cut with
    /// an ellipsis when needed.
    pub fn truncate_text(text: &str) -> String {
        if text.len() <= Self::MAX_LENGTH {
            return text.to_string();
        }

        // Try to truncate at sentence boundaries
        let sentences: Vec<&str> = text.split_inclusive(['.', '!', '?']).collect();
        let mut truncated = String::new();

        for sentence in sentences {
            if truncated.len() + sentence.len() <= Self::MAX_LENGTH {
                truncated.push_str(sentence);
            } else {
                break;
            }
        }

        if truncated.is_empty() {
            format!("{}...", &text[..Self::MAX_LENGTH.saturating_sub(3)])
        } else {
            truncated.trim().to_string()
        }
    }

    /// Execute the POST action: validate input, truncate, and create the post.
    pub async fn handle(client: &TwitterClient, text: &str) -> PostActionResult {
        let text = text.trim();

        if text.is_empty() {
            return PostActionResult {
                success: false,
                text: "I need something to post! Please provide the text.".to_string(),
                post_id: None,
                post_url: None,
                error: Some("No text provided".to_string()),
            };
        }

        let final_text = Self::truncate_text(text);

        info!(
            "Executing POST action with text: {}",
            &final_text[..final_text.len().min(50)]
        );

        match client.create_post(&final_text).await {
            Ok(result) => {
                let post_id = result.id.clone();
                let username = client.username().unwrap_or("user");
                let post_url = format!("https://x.com/{}/status/{}", username, post_id);

                info!("Posted successfully: {}", post_id);

                PostActionResult {
                    success: true,
                    text: format!("Posted: \"{}\"\n\n{}", final_text, post_url),
                    post_id: Some(post_id),
                    post_url: Some(post_url),
                    error: None,
                }
            }
            Err(e) => {
                error!("Failed to post: {}", e);
                PostActionResult {
                    success: false,
                    text: format!("Failed to post: {}", e),
                    post_id: None,
                    post_url: None,
                    error: Some(e.to_string()),
                }
            }
        }
    }
}

/// Example conversation snippets demonstrating how to invoke the POST action.
pub const POST_EXAMPLES: &[&[(&str, &str)]] = &[
    &[
        ("{{user1}}", "Post about the weather today"),
        ("{{agent}}", "I'll post about today's weather."),
    ],
    &[
        (
            "{{user1}}",
            "Post: The future of AI is collaborative intelligence",
        ),
        ("{{agent}}", "I'll post that for you."),
    ],
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_action_metadata() {
        assert_eq!(PostAction::NAME, "POST");
        assert!(!PostAction::DESCRIPTION.is_empty());
        assert!(!PostAction::SIMILES.is_empty());
        assert!(PostAction::SIMILES.contains(&"TWEET"));
    }

    #[test]
    fn test_truncate_short_text() {
        let text = "Hello world";
        assert_eq!(PostAction::truncate_text(text), "Hello world");
    }

    #[test]
    fn test_truncate_long_text() {
        let text = "a".repeat(300);
        let truncated = PostAction::truncate_text(&text);
        assert!(truncated.len() <= PostAction::MAX_LENGTH);
        assert!(truncated.ends_with("..."));
    }

    #[test]
    fn test_truncate_at_sentence() {
        let text = "First sentence. Second sentence. Third sentence that is really long and will push us over the limit because it just keeps going and going and going and going and going and going and going.";
        let truncated = PostAction::truncate_text(text);
        assert!(truncated.len() <= PostAction::MAX_LENGTH);
        assert!(truncated.ends_with('.'));
    }
}
