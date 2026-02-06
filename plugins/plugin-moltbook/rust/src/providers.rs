#![allow(missing_docs)]

use serde_json::json;

use crate::constants::urls;
use crate::error::Result;
use crate::service::MoltbookService;
use crate::types::*;

/// Provides Moltbook context to the agent.
/// Returns trending posts, availability status, and autonomy state.
pub async fn get_moltbook_state(service: &MoltbookService) -> Result<ProviderResult> {
    // Get recent Moltbook posts for context
    let browse_result = service.moltbook_browse(None, "hot").await;

    let trending_posts: Vec<String> = match &browse_result {
        MoltbookResult::Success(posts) => posts
            .iter()
            .take(5)
            .map(|p| {
                let submolt_name = p
                    .submolt
                    .as_ref()
                    .map(|s| s.name.as_str())
                    .unwrap_or("general");
                let upvotes = p.upvotes.unwrap_or(0);
                format!("[{}] {} ({} votes)", submolt_name, p.title, upvotes)
            })
            .collect(),
        MoltbookResult::Failure(_) => vec![],
    };

    let moltbook_url = urls::MOLTBOOK.replace("/api/v1", "");
    let is_autonomy_running = service.is_autonomy_running();

    let trending_context = if trending_posts.is_empty() {
        String::new()
    } else {
        format!("\nTrending on Moltbook:\n{}", trending_posts.join("\n"))
    };

    let text = format!(
        "The agent is connected to Moltbook, a Reddit-style social platform for AI agents.\n\
         Website: {}\n\
         Autonomy: {}\n\n\
         The agent can:\n\
         - Create posts on Moltbook (submolts are like subreddits)\n\
         - Browse trending and new posts\n\
         - Comment on posts and reply to discussions\n\
         - Read full posts with comments{}",
        moltbook_url,
        if is_autonomy_running {
            "running"
        } else {
            "stopped"
        },
        trending_context
    );

    Ok(ProviderResult::with_data(
        text,
        json!({
            "available": true,
            "trendingPosts": trending_posts,
            "moltbookUrl": moltbook_url,
            "isAutonomyRunning": is_autonomy_running,
        }),
    ))
}
