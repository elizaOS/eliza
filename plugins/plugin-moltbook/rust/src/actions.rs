#![allow(missing_docs)]

use serde_json::{json, Value};

use crate::constants::DEFAULT_SUBMOLT;
use crate::error::{MoltbookError, Result};
use crate::service::MoltbookService;
use crate::types::*;

pub type ActionHandler = fn(
    &MoltbookService,
    Value,
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<ActionResult>> + Send + '_>,
>;

/// MOLTBOOK_POST - Create a post on Moltbook
pub async fn moltbook_post(service: &MoltbookService, params: Value) -> Result<ActionResult> {
    let submolt = params
        .get("submolt")
        .and_then(|s| s.as_str())
        .unwrap_or(DEFAULT_SUBMOLT);

    let title = params
        .get("title")
        .and_then(|t| t.as_str())
        .ok_or_else(|| MoltbookError::InvalidInput("Title is required".to_string()))?;

    let content = params
        .get("content")
        .and_then(|c| c.as_str())
        .ok_or_else(|| MoltbookError::InvalidInput("Content is required".to_string()))?;

    let post_id = service.moltbook_post(submolt, title, content).await?;

    Ok(ActionResult::success_with_data(
        format!("Posted to Moltbook! Post ID: {} in r/{}", post_id, submolt),
        json!({
            "postId": post_id,
            "submolt": submolt,
            "title": title,
        }),
    ))
}

/// MOLTBOOK_BROWSE - Browse posts on Moltbook
pub async fn moltbook_browse(service: &MoltbookService, params: Value) -> Result<ActionResult> {
    let submolt = params.get("submolt").and_then(|s| s.as_str());
    let sort = params
        .get("sort")
        .and_then(|s| s.as_str())
        .unwrap_or("hot");

    let result = service.moltbook_browse(submolt, sort).await;

    match result {
        MoltbookResult::Failure(error) => Ok(ActionResult::error(format!(
            "Failed to browse Moltbook: {}",
            error
        ))),
        MoltbookResult::Success(posts) => {
            if posts.is_empty() {
                return Ok(ActionResult::success_with_data(
                    "No posts found on Moltbook.",
                    json!({ "posts": [] }),
                ));
            }

            let formatted_posts: Vec<String> = posts
                .iter()
                .take(8)
                .map(|p| {
                    let submolt_name = p
                        .submolt
                        .as_ref()
                        .map(|s| s.name.as_str())
                        .unwrap_or("general");
                    let author_name = p
                        .author
                        .as_ref()
                        .map(|a| a.name.as_str())
                        .unwrap_or("anon");
                    let upvotes = p.upvotes.unwrap_or(0);
                    let comments = p.comment_count.unwrap_or(0);

                    format!(
                        "[id:{}] [{}] {} by {} ({} votes, {} comments)",
                        p.id, submolt_name, p.title, author_name, upvotes, comments
                    )
                })
                .collect();

            Ok(ActionResult::success_with_data(
                format!(
                    "Moltbook posts ({}):\n\n{}",
                    sort,
                    formatted_posts.join("\n")
                ),
                json!({ "posts": posts }),
            ))
        }
    }
}

/// MOLTBOOK_COMMENT - Comment on a Moltbook post
pub async fn moltbook_comment(service: &MoltbookService, params: Value) -> Result<ActionResult> {
    let post_id = params
        .get("postId")
        .and_then(|p| p.as_str())
        .ok_or_else(|| MoltbookError::InvalidInput("Post ID is required".to_string()))?;

    let content = params
        .get("content")
        .and_then(|c| c.as_str())
        .ok_or_else(|| MoltbookError::InvalidInput("Comment content is required".to_string()))?;

    let parent_id = params.get("parentId").and_then(|p| p.as_str());

    let comment_id = if let Some(parent) = parent_id {
        // Reply to a comment
        service.moltbook_reply(post_id, parent, content).await?
    } else {
        // Comment on the post
        service.moltbook_comment(post_id, content).await?
    };

    Ok(ActionResult::success_with_data(
        format!("Comment posted successfully! Comment ID: {}", comment_id),
        json!({
            "commentId": comment_id,
            "postId": post_id,
            "parentId": parent_id,
        }),
    ))
}

/// MOLTBOOK_READ - Read a specific Moltbook post with comments
pub async fn moltbook_read(service: &MoltbookService, params: Value) -> Result<ActionResult> {
    let post_id = params
        .get("postId")
        .and_then(|p| p.as_str())
        .ok_or_else(|| MoltbookError::InvalidInput("Post ID is required".to_string()))?;

    let result = service.moltbook_read_post(post_id).await?;
    let post = &result.post;
    let comments = &result.comments;

    let formatted_comments = if comments.is_empty() {
        "  (no comments yet)".to_string()
    } else {
        comments
            .iter()
            .take(10)
            .map(|c| {
                let author_name = c
                    .author
                    .as_ref()
                    .map(|a| a.name.as_str())
                    .unwrap_or("anon");
                let content = if c.content.len() > 200 {
                    format!("{}...", &c.content[..200])
                } else {
                    c.content.clone()
                };
                format!("  - {}: {}", author_name, content)
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    let post_content = post
        .content
        .as_deref()
        .or(post.body.as_deref())
        .unwrap_or("(no content)");

    let truncated_content = if post_content.len() > 500 {
        format!("{}...", &post_content[..500])
    } else {
        post_content.to_string()
    };

    let submolt_name = post
        .submolt
        .as_ref()
        .map(|s| s.name.as_str())
        .unwrap_or("general");
    let author_name = post
        .author
        .as_ref()
        .map(|a| a.name.as_str())
        .unwrap_or("anon");
    let upvotes = post.upvotes.unwrap_or(0);
    let comment_count = post.comment_count.unwrap_or(0);

    let formatted_post = format!(
        "**{}**\nby {} in r/{}\n{} upvotes | {} comments\n\n{}\n\nComments:\n{}",
        post.title,
        author_name,
        submolt_name,
        upvotes,
        comment_count,
        truncated_content,
        formatted_comments
    );

    Ok(ActionResult::success_with_data(
        formatted_post,
        json!({
            "post": post,
            "comments": comments,
        }),
    ))
}

/// MOLTBOOK_SUBMOLTS - List or examine submolts
pub async fn moltbook_submolts(service: &MoltbookService, params: Value) -> Result<ActionResult> {
    let submolt_name = params.get("submolt").and_then(|s| s.as_str());

    // If a specific submolt is requested, get its details
    if let Some(name) = submolt_name {
        let submolt_result = service.moltbook_get_submolt(name).await;

        match submolt_result {
            MoltbookResult::Failure(error) => {
                return Ok(ActionResult::error(format!(
                    "Failed to get submolt: {}",
                    error
                )));
            }
            MoltbookResult::Success(None) => {
                return Ok(ActionResult::error(format!(
                    "Submolt \"m/{}\" not found.",
                    name
                )));
            }
            MoltbookResult::Success(Some(submolt)) => {
                // Also get recent posts from this submolt
                let posts_result = service.moltbook_browse(Some(name), "hot").await;
                let posts = match &posts_result {
                    MoltbookResult::Success(p) => p.clone(),
                    MoltbookResult::Failure(_) => vec![],
                };

                let recent_posts = if posts.is_empty() {
                    "  (no recent posts)".to_string()
                } else {
                    posts
                        .iter()
                        .take(5)
                        .map(|p| {
                            let author_name = p
                                .author
                                .as_ref()
                                .map(|a| a.name.as_str())
                                .unwrap_or("anon");
                            let upvotes = p.upvotes.unwrap_or(0);
                            format!("  - {} by {} ({} votes)", p.title, author_name, upvotes)
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                };

                let description = submolt
                    .description
                    .as_deref()
                    .unwrap_or("(no description)");

                let subscriber_count = submolt
                    .subscriber_count
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "unknown".to_string());

                let post_count = submolt
                    .post_count
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "unknown".to_string());

                let created_info = submolt
                    .created_at
                    .as_ref()
                    .map(|d| format!("\nCreated: {}", d))
                    .unwrap_or_default();

                let submolt_info = format!(
                    "**m/{}**\n{}\n\nSubscribers: {}\nPosts: {}{}\n\nRecent posts:\n{}",
                    submolt.name,
                    description,
                    subscriber_count,
                    post_count,
                    created_info,
                    recent_posts
                );

                return Ok(ActionResult::success_with_data(
                    submolt_info,
                    json!({
                        "submolt": submolt,
                        "posts": posts,
                    }),
                ));
            }
        }
    }

    // Otherwise, list all submolts
    let submolts_result = service.moltbook_list_submolts("popular").await;

    match submolts_result {
        MoltbookResult::Failure(error) => Ok(ActionResult::error(format!(
            "Failed to get submolts: {}",
            error
        ))),
        MoltbookResult::Success(submolts) => {
            if submolts.is_empty() {
                return Ok(ActionResult::success_with_data(
                    "No submolts found on Moltbook.",
                    json!({ "submolts": [] }),
                ));
            }

            let formatted_submolts: Vec<String> = submolts
                .iter()
                .take(15)
                .map(|s| {
                    let desc = s
                        .description
                        .as_deref()
                        .map(|d| {
                            if d.len() > 60 {
                                format!("{}...", &d[..60])
                            } else {
                                d.to_string()
                            }
                        })
                        .unwrap_or_else(|| "(no description)".to_string());
                    let members = s.subscriber_count.unwrap_or(0);
                    format!("- m/{} - {} ({} members)", s.name, desc, members)
                })
                .collect();

            Ok(ActionResult::success_with_data(
                format!(
                    "Available submolts on Moltbook:\n\n{}\n\nUse \"examine m/[name]\" to see details about a specific submolt.",
                    formatted_submolts.join("\n")
                ),
                json!({ "submolts": submolts }),
            ))
        }
    }
}
