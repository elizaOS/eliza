//! POST action implementation for X/Twitter.

use tracing::{error, info};

use crate::client::TwitterClient;

/// Result of a post action.
#[derive(Debug, Clone)]
pub struct PostActionResult {
    /// Whether the action succeeded.
    pub success: bool,
    /// Response text.
    pub text: String,
    /// Post ID if successful.
    pub post_id: Option<String>,
    /// Post URL if successful.
    pub post_url: Option<String>,
    /// Error message if failed.
    pub error: Option<String>,
}

/// Post Action for X/Twitter.
///
/// Posts content on X (formerly Twitter).
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

    /// Maximum post length.
    pub const MAX_LENGTH: usize = 280;

    /// Validate if the action can be executed.
    pub fn validate(client: &TwitterClient) -> bool {
        // Check if client is properly configured
        client.is_authenticated()
    }

    /// Truncate text to fit within X's character limit.
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
            // No complete sentence fits, just truncate with ellipsis
            format!("{}...", &text[..Self::MAX_LENGTH.saturating_sub(3)])
        } else {
            truncated.trim().to_string()
        }
    }

    /// Execute the post action.
    ///
    /// # Arguments
    ///
    /// * `client` - The Twitter client.
    /// * `text` - The text to post.
    ///
    /// # Returns
    ///
    /// The post result.
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

        // Truncate if needed
        let final_text = Self::truncate_text(text);

        info!("Executing POST action with text: {}", &final_text[..final_text.len().min(50)]);

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

/// Example conversations for the post action.
pub const POST_EXAMPLES: &[&[(&str, &str)]] = &[
    &[
        ("{{user1}}", "Post about the weather today"),
        ("{{agent}}", "I'll post about today's weather."),
    ],
    &[
        ("{{user1}}", "Post: The future of AI is collaborative intelligence"),
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
