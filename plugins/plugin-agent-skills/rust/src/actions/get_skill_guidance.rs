//! Get Skill Guidance Action
//!
//! Main action for skill-powered assistance. Searches for relevant skills,
//! optionally auto-installs them, and returns the skill instructions.

use crate::service::AgentSkillsService;
use crate::types::Skill;
use super::ActionResult;

/// Action that provides skill-based guidance.
pub struct GetSkillGuidanceAction;

impl GetSkillGuidanceAction {
    /// Action name constant.
    pub const NAME: &'static str = "GET_SKILL_GUIDANCE";

    /// Action description.
    pub const DESCRIPTION: &'static str =
        "Search for and get skill instructions. Use when user asks to find a skill or when you need instructions for a capability.";

    /// Similar action names.
    pub const SIMILES: &[&'static str] = &[
        "FIND_SKILL",
        "SEARCH_SKILLS",
        "SKILL_HELP",
        "HOW_TO",
        "GET_INSTRUCTIONS",
        "LEARN_SKILL",
        "LOOKUP_SKILL",
    ];

    /// Execute the get skill guidance action.
    pub async fn handle(
        service: &mut AgentSkillsService,
        query: &str,
    ) -> ActionResult {
        if query.len() < 3 {
            return ActionResult::fail("Query too short");
        }

        let search_terms = extract_search_terms(query);

        // Step 1: Search registry
        let search_results = match service.search(&search_terms, 5, false).await {
            Ok(r) => r,
            Err(e) => return ActionResult::fail(format!("Search error: {}", e)),
        };

        // Step 2: Check installed skills
        let installed_skills: Vec<Skill> = service
            .get_loaded_skills()
            .into_iter()
            .cloned()
            .collect();
        let local_match = find_best_local_match(&installed_skills, &search_terms);

        // Step 3: Decide best option
        let best_remote = search_results.first();
        let remote_score = best_remote.map(|r| r.score * 100.0).unwrap_or(0.0);
        let local_is_strong = local_match
            .as_ref()
            .map(|(_, score)| *score >= 8)
            .unwrap_or(false);

        if best_remote.is_none()
            || (best_remote.unwrap().score < 0.25 && !local_is_strong)
        {
            return ActionResult::ok(format!(
                "I couldn't find a specific skill for \"{}\". I'll do my best with my general knowledge.",
                search_terms
            ));
        }

        // Prefer local if strong
        let use_local = local_is_strong
            && local_match
                .as_ref()
                .map(|(_, score)| (*score as f64) >= remote_score)
                .unwrap_or(false);

        if use_local {
            if let Some((skill, _)) = &local_match {
                let instructions = service.get_skill_instructions(&skill.slug);
                return build_success_result(
                    skill,
                    instructions.map(|i| i.body),
                    "local",
                );
            }
        }

        let best_remote = match best_remote {
            Some(r) => r,
            None => {
                return ActionResult::ok(format!(
                    "I couldn't find a specific skill for \"{}\".",
                    search_terms
                ))
            }
        };

        // Step 4: Auto-install
        let already_installed = service.is_installed(&best_remote.slug);

        if !already_installed {
            match service.install(&best_remote.slug, None, false).await {
                Ok(true) => {}
                _ => {
                    if let Some((skill, _)) = &local_match {
                        let instructions = service.get_skill_instructions(&skill.slug);
                        return build_success_result(
                            skill,
                            instructions.map(|i| i.body),
                            "local",
                        );
                    }
                    return ActionResult::ok(format!(
                        "Found \"{}\" skill but couldn't install it.",
                        best_remote.display_name
                    ));
                }
            }
        }

        // Step 5: Return instructions
        if let Some(skill) = service.get_loaded_skill(&best_remote.slug) {
            let instructions = service.get_skill_instructions(&skill.slug);
            let source = if already_installed { "local" } else { "installed" };
            return build_success_result(skill, instructions.map(|i| i.body), source);
        }

        ActionResult::ok(format!(
            "Found \"{}\" skill but couldn't load instructions.",
            best_remote.display_name
        ))
    }
}

fn extract_search_terms(query: &str) -> String {
    static STOP_WORDS: &[&str] = &[
        "search", "find", "look", "for", "a", "an", "the", "skill", "skills",
        "please", "can", "you", "help", "me", "with", "how", "to", "do", "i",
        "need", "want", "get", "use", "using", "about", "is", "are", "there",
        "any", "some", "show", "list", "give", "tell", "what", "which",
    ];

    let lower = query.to_lowercase();
    let words: Vec<&str> = lower
        .split_whitespace()
        .filter(|w| w.len() > 1 && !STOP_WORDS.contains(w))
        .collect();

    if words.is_empty() {
        lower
    } else {
        words.join(" ")
    }
}

fn find_best_local_match(skills: &[Skill], query: &str) -> Option<(Skill, i32)> {
    let query_lower = query.to_lowercase();
    let query_words: Vec<&str> = query_lower
        .split_whitespace()
        .filter(|w| w.len() > 2)
        .collect();

    let mut best: Option<(Skill, i32)> = None;

    for skill in skills {
        let mut score: i32 = 0;
        let slug_lower = skill.slug.to_lowercase();
        let name_lower = skill.name.to_lowercase();

        if query_lower.contains(&slug_lower)
            || query_words.iter().any(|w| w.len() > 3 && slug_lower.contains(w))
        {
            score += 10;
        }

        if query_lower.contains(&name_lower)
            || query_words.iter().any(|w| w.len() > 3 && name_lower.contains(w))
        {
            score += 8;
        }

        if score > 0 {
            if best.is_none() || score > best.as_ref().unwrap().1 {
                best = Some((skill.clone(), score));
            }
        }
    }

    best
}

fn build_success_result(
    skill: &Skill,
    instructions: Option<String>,
    source: &str,
) -> ActionResult {
    let mut text = format!("## {}\n\n", skill.name);

    if source == "installed" {
        text.push_str("*Skill installed from registry*\n\n");
    }

    text.push_str(&skill.description);
    text.push_str("\n\n");

    if let Some(body) = instructions {
        let max_len = 3500;
        let truncated = if body.len() > max_len {
            format!("{}\n\n...[truncated]", &body[..max_len])
        } else {
            body
        };
        text.push_str("### Instructions\n\n");
        text.push_str(&truncated);
    }

    ActionResult::ok(text)
}
