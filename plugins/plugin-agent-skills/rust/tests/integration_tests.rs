//! Integration Tests with Anthropic API
//!
//! These tests verify that skills work end-to-end with a real Anthropic API.
//! They load real Otto skills, format them for prompt injection, and verify
//! the agent can understand and use the skill instructions.
//!
//! Run with: ANTHROPIC_API_KEY=your-key cargo test --test integration_tests

use elizaos_plugin_agent_skills::parser::{
    extract_body, generate_skills_xml, parse_frontmatter, validate_frontmatter,
};
use elizaos_plugin_agent_skills::storage::{
    load_skill_from_storage, FileSystemSkillStore, MemorySkillStore, SkillStorage,
};
use elizaos_plugin_agent_skills::types::SkillMetadataEntry;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::env;
use std::path::PathBuf;

// ============================================================
// ANTHROPIC API TYPES
// ============================================================

#[derive(Debug, Serialize)]
struct AnthropicRequest {
    model: String,
    max_tokens: u32,
    system: Option<String>,
    messages: Vec<AnthropicMessage>,
}

#[derive(Debug, Serialize)]
struct AnthropicMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct AnthropicResponse {
    content: Vec<AnthropicContent>,
}

#[derive(Debug, Deserialize)]
struct AnthropicContent {
    #[serde(rename = "type")]
    content_type: String,
    text: Option<String>,
}

// ============================================================
// TEST HELPERS
// ============================================================

fn get_api_key() -> Option<String> {
    env::var("ANTHROPIC_API_KEY").ok()
}

fn get_otto_skills_path() -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest_dir)
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("otto")
        .join("skills")
}

async fn call_anthropic(
    client: &Client,
    api_key: &str,
    system: &str,
    user_message: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let request = AnthropicRequest {
        model: "claude-3-5-haiku-20241022".to_string(),
        max_tokens: 500,
        system: Some(system.to_string()),
        messages: vec![AnthropicMessage {
            role: "user".to_string(),
            content: user_message.to_string(),
        }],
    };

    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&request)
        .send()
        .await?;

    let result: AnthropicResponse = response.json().await?;

    Ok(result
        .content
        .into_iter()
        .filter_map(|c| c.text)
        .collect::<Vec<_>>()
        .join(""))
}

fn load_skill_content(skill_name: &str) -> Option<String> {
    let skills_path = get_otto_skills_path();
    let skill_path = skills_path.join(skill_name).join("SKILL.md");

    if skill_path.exists() {
        std::fs::read_to_string(skill_path).ok()
    } else {
        None
    }
}

fn create_system_prompt_with_skills(skills: &[(String, String, String)]) -> String {
    let metadata: Vec<SkillMetadataEntry> = skills
        .iter()
        .map(|(name, description, location)| SkillMetadataEntry {
            name: name.clone(),
            description: description.clone(),
            location: location.clone(),
        })
        .collect();

    let skills_xml = generate_skills_xml(&metadata, false);

    format!(
        r#"You are a helpful assistant with access to the following skills:

{}

When a user asks about something covered by a skill, refer to and use that skill's capabilities.
If a skill requires specific CLI tools, mention what's needed."#,
        skills_xml
    )
}

// ============================================================
// SKILL LOADING TESTS (no API key required)
// ============================================================

#[test]
fn test_load_github_skill() {
    let content = match load_skill_content("github") {
        Some(c) => c,
        None => {
            println!("Skipping: github skill not found");
            return;
        }
    };

    let (frontmatter, body, _) = parse_frontmatter(&content);
    assert!(frontmatter.is_some());

    let fm = frontmatter.unwrap();
    assert_eq!(fm.name, "github");
    assert!(fm.description.contains("gh"));

    // Check Otto metadata
    assert!(fm.metadata.is_some());
    let metadata = fm.metadata.unwrap();
    assert!(metadata.otto.is_some());
    let otto = metadata.otto.unwrap();
    assert!(otto.requires.is_some());
}

#[test]
fn test_load_clawhub_skill() {
    let content = match load_skill_content("clawhub") {
        Some(c) => c,
        None => {
            println!("Skipping: clawhub skill not found");
            return;
        }
    };

    let (frontmatter, _, _) = parse_frontmatter(&content);
    assert!(frontmatter.is_some());

    let fm = frontmatter.unwrap();
    assert_eq!(fm.name, "clawhub");
}

#[test]
fn test_load_multiple_skills_memory_store() {
    let rt = tokio::runtime::Runtime::new().unwrap();

    rt.block_on(async {
        let mut store = MemorySkillStore::new("/virtual/skills");
        store.initialize().await.unwrap();

        let skill_names = ["github", "clawhub", "tmux"];
        let mut loaded_count = 0;

        for name in &skill_names {
            if let Some(content) = load_skill_content(name) {
                store.load_from_content(name, &content, None).await.unwrap();
                loaded_count += 1;
            }
        }

        let skills = store.list_skills().await.unwrap();
        assert_eq!(skills.len(), loaded_count);
    });
}

#[test]
fn test_generate_skills_xml_from_loaded() {
    let content = match load_skill_content("github") {
        Some(c) => c,
        None => {
            println!("Skipping: github skill not found");
            return;
        }
    };

    let (frontmatter, _, _) = parse_frontmatter(&content);
    let fm = frontmatter.unwrap();

    let metadata = vec![SkillMetadataEntry {
        name: fm.name.clone(),
        description: fm.description.clone(),
        location: "/path/to/github/SKILL.md".to_string(),
    }];

    let xml = generate_skills_xml(&metadata, true);

    assert!(xml.contains("<available_skills>"));
    assert!(xml.contains("</available_skills>"));
    assert!(xml.contains(&format!("<name>{}</name>", fm.name)));
}

// ============================================================
// ANTHROPIC INTEGRATION TESTS
// ============================================================

#[tokio::test]
async fn test_anthropic_understand_github_skill() {
    let api_key = match get_api_key() {
        Some(key) => key,
        None => {
            println!("Skipping: ANTHROPIC_API_KEY not set");
            return;
        }
    };

    let content = match load_skill_content("github") {
        Some(c) => c,
        None => {
            println!("Skipping: github skill not found");
            return;
        }
    };

    let (frontmatter, _, _) = parse_frontmatter(&content);
    let fm = frontmatter.unwrap();

    let skills = vec![(
        fm.name.clone(),
        fm.description.clone(),
        "/skills/github/SKILL.md".to_string(),
    )];
    let system_prompt = create_system_prompt_with_skills(&skills);

    let client = Client::new();
    let response = call_anthropic(
        &client,
        &api_key,
        &system_prompt,
        "How do I list my open pull requests using the skills you have?",
    )
    .await
    .expect("API call should succeed");

    let lower = response.to_lowercase();
    assert!(
        lower.contains("gh") || lower.contains("github") || lower.contains("pull request"),
        "Response should mention gh CLI: {}",
        response
    );
    assert!(response.len() > 50, "Response should be substantial");
}

#[tokio::test]
async fn test_anthropic_identify_dependencies() {
    let api_key = match get_api_key() {
        Some(key) => key,
        None => {
            println!("Skipping: ANTHROPIC_API_KEY not set");
            return;
        }
    };

    let content = match load_skill_content("github") {
        Some(c) => c,
        None => {
            println!("Skipping: github skill not found");
            return;
        }
    };

    let (frontmatter, _, _) = parse_frontmatter(&content);
    let fm = frontmatter.unwrap();
    let body = extract_body(&content);

    let system_prompt = format!(
        r#"You help users with command-line tools.

Here is your skill documentation:

<skill name="{}">
{}
</skill>

When answering, mention any required tools or dependencies."#,
        fm.name, body
    );

    let client = Client::new();
    let response = call_anthropic(
        &client,
        &api_key,
        &system_prompt,
        "What do I need installed to use this GitHub skill?",
    )
    .await
    .expect("API call should succeed");

    let lower = response.to_lowercase();
    assert!(
        lower.contains("gh") || lower.contains("github cli"),
        "Response should mention gh CLI requirement: {}",
        response
    );
}

#[tokio::test]
async fn test_anthropic_multiple_skills() {
    let api_key = match get_api_key() {
        Some(key) => key,
        None => {
            println!("Skipping: ANTHROPIC_API_KEY not set");
            return;
        }
    };

    let skill_names = ["github", "clawhub", "tmux"];
    let mut skills: Vec<(String, String, String)> = Vec::new();

    for name in &skill_names {
        if let Some(content) = load_skill_content(name) {
            let (frontmatter, _, _) = parse_frontmatter(&content);
            if let Some(fm) = frontmatter {
                skills.push((
                    fm.name.clone(),
                    fm.description.clone(),
                    format!("/skills/{}/SKILL.md", name),
                ));
            }
        }
    }

    if skills.len() < 2 {
        println!("Skipping: need at least 2 skills");
        return;
    }

    let system_prompt = create_system_prompt_with_skills(&skills);

    let client = Client::new();
    let response = call_anthropic(
        &client,
        &api_key,
        &system_prompt,
        "What skills do you have available? List them briefly.",
    )
    .await
    .expect("API call should succeed");

    let lower = response.to_lowercase();
    let mentioned_count = skills
        .iter()
        .filter(|(name, _, _)| lower.contains(&name.to_lowercase()))
        .count();

    assert!(
        mentioned_count >= 1,
        "Should mention at least one skill: {}",
        response
    );
}

#[tokio::test]
async fn test_anthropic_use_skill_instructions() {
    let api_key = match get_api_key() {
        Some(key) => key,
        None => {
            println!("Skipping: ANTHROPIC_API_KEY not set");
            return;
        }
    };

    let content = match load_skill_content("github") {
        Some(c) => c,
        None => {
            println!("Skipping: github skill not found");
            return;
        }
    };

    let body = extract_body(&content);

    let system_prompt = format!(
        r#"You are a coding assistant with the following skill:

<skill>
{}
</skill>

Provide specific commands when asked about GitHub tasks. Format commands in code blocks."#,
        body
    );

    let client = Client::new();
    let response = call_anthropic(
        &client,
        &api_key,
        &system_prompt,
        r#"Show me the command to create a new GitHub issue with the title "Bug fix needed""#,
    )
    .await
    .expect("API call should succeed");

    assert!(
        response.contains("gh") && response.to_lowercase().contains("issue"),
        "Response should include gh issue command: {}",
        response
    );
}

// ============================================================
// OTTO COMPATIBILITY TESTS
// ============================================================

#[tokio::test]
async fn test_anthropic_otto_install_instructions() {
    let api_key = match get_api_key() {
        Some(key) => key,
        None => {
            println!("Skipping: ANTHROPIC_API_KEY not set");
            return;
        }
    };

    let content = match load_skill_content("github") {
        Some(c) => c,
        None => {
            println!("Skipping: github skill not found");
            return;
        }
    };

    let (frontmatter, _, _) = parse_frontmatter(&content);
    let fm = frontmatter.unwrap();

    // Get install options from Otto metadata
    let install_json = if let Some(metadata) = &fm.metadata {
        if let Some(otto) = metadata.otto.as_ref() {
            serde_json::to_string_pretty(&otto.install).unwrap_or_default()
        } else {
            "[]".to_string()
        }
    } else {
        "[]".to_string()
    };

    let system_prompt = format!(
        r#"You help users install tools.

For the {} skill, here are the installation options:
{}

Provide platform-appropriate install commands."#,
        fm.name, install_json
    );

    let client = Client::new();
    let response = call_anthropic(
        &client,
        &api_key,
        &system_prompt,
        "How do I install the GitHub CLI on macOS?",
    )
    .await
    .expect("API call should succeed");

    let lower = response.to_lowercase();
    assert!(
        lower.contains("brew") || lower.contains("homebrew"),
        "Response should mention brew for macOS: {}",
        response
    );
}
