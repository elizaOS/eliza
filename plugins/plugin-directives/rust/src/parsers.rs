use regex::Regex;

use crate::types::*;

// ============================================================================
// Internal Helpers
// ============================================================================

/// Result of a raw directive match (position + optional argument text).
struct DirectiveMatch {
    /// Start of the match region (includes leading whitespace if any).
    start: usize,
    /// End of the match region (past the argument if one was consumed).
    end: usize,
    /// The raw argument text captured after the directive name, if any.
    raw_level: Option<String>,
}

/// Internal result of a full extraction (found flag + optional typed level + cleaned text).
struct ExtractResult<T> {
    found: bool,
    level: Option<T>,
    cleaned: String,
}

/// Check whether the byte at `pos` in `text` is a valid directive boundary
/// (end of string, ASCII whitespace, or `:`).
fn is_valid_boundary(text: &str, pos: usize) -> bool {
    if pos >= text.len() {
        return true;
    }
    let b = text.as_bytes()[pos];
    b.is_ascii_whitespace() || b == b':'
}

/// Locate a level-based directive (e.g. `/think`, `/verbose`) in `text`.
///
/// `names` must be sorted longest-first so that the regex alternation prefers
/// the longest match (leftmost-first semantics).
///
/// Returns the match region (for cleaning) and the raw argument string.
fn find_directive_match(text: &str, names: &[&str]) -> Option<DirectiveMatch> {
    // Build alternation pattern – names MUST already be sorted longest-first.
    let pattern = names
        .iter()
        .map(|n| regex::escape(n))
        .collect::<Vec<_>>()
        .join("|");
    let re = Regex::new(&format!(r"(?i)(?:^|\s)/({})", pattern)).unwrap();

    for caps in re.captures_iter(text) {
        let full = caps.get(0).unwrap();
        let name_group = caps.get(1).unwrap();
        let name_end = name_group.end();

        // Boundary: the character immediately after the matched name must be
        // end-of-string, whitespace, or ':'.
        if !is_valid_boundary(text, name_end) {
            continue;
        }

        // --- scan for optional colon + argument value ---
        let bytes = text.as_bytes();
        let mut i = name_end;

        // skip whitespace
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        // optional colon separator
        if i < bytes.len() && bytes[i] == b':' {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
        }
        // read argument word [A-Za-z0-9_-]+
        let arg_start = i;
        while i < bytes.len()
            && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'-' || bytes[i] == b'_')
        {
            i += 1;
        }

        let raw_level = if i > arg_start {
            Some(text[arg_start..i].to_string())
        } else {
            None
        };

        return Some(DirectiveMatch {
            start: full.start(),
            end: i,
            raw_level,
        });
    }

    None
}

/// Remove the range `start..end` from `text` and collapse whitespace.
fn clean_text(text: &str, start: usize, end: usize) -> String {
    let before = &text[..start];
    let after = if end < text.len() { &text[end..] } else { "" };
    format!("{} {}", before, after)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Generic extraction helper: find the directive, normalize its value, clean
/// the text, and return the full result.
fn extract_level<T, F>(
    text: &str,
    names: &[&str],
    normalize: F,
) -> ExtractResult<T>
where
    F: Fn(&str) -> Option<T>,
{
    if let Some(dm) = find_directive_match(text, names) {
        let level = dm.raw_level.as_deref().and_then(&normalize);
        let cleaned = clean_text(text, dm.start, dm.end);
        ExtractResult {
            found: true,
            level,
            cleaned,
        }
    } else {
        ExtractResult {
            found: false,
            level: None,
            cleaned: text.trim().to_string(),
        }
    }
}

// ============================================================================
// Normalizers  (public so callers can re-use them)
// ============================================================================

/// Normalize a raw string to a [`ThinkLevel`].
pub fn normalize_think_level(raw: &str) -> Option<ThinkLevel> {
    match raw.to_lowercase().as_str() {
        "off" | "none" | "disable" | "disabled" => Some(ThinkLevel::Off),
        "on" | "enable" | "enabled" | "concise" | "min" | "minimal" | "low" | "think" => {
            Some(ThinkLevel::Concise)
        }
        "verbose" | "full" | "high" | "ultra" | "max" | "medium" | "med" | "mid" | "xhigh"
        | "x-high" | "x_high" | "harder" | "hardest" => Some(ThinkLevel::Verbose),
        _ => None,
    }
}

/// Normalize a raw string to a [`VerboseLevel`].
pub fn normalize_verbose_level(raw: &str) -> Option<VerboseLevel> {
    match raw.to_lowercase().as_str() {
        "off" | "false" | "no" | "0" | "disable" | "disabled" => Some(VerboseLevel::Off),
        "on" | "true" | "yes" | "1" | "full" | "all" | "enable" | "enabled" | "everything" => {
            Some(VerboseLevel::On)
        }
        _ => None,
    }
}

/// Normalize a raw string to a [`ReasoningLevel`].
pub fn normalize_reasoning_level(raw: &str) -> Option<ReasoningLevel> {
    match raw.to_lowercase().as_str() {
        "off" | "false" | "no" | "0" | "hide" | "hidden" | "disable" | "disabled" => {
            Some(ReasoningLevel::Off)
        }
        "on" | "true" | "yes" | "1" | "show" | "visible" | "enable" | "enabled" | "brief" => {
            Some(ReasoningLevel::Brief)
        }
        "detailed" | "stream" | "streaming" | "draft" | "live" | "full" => {
            Some(ReasoningLevel::Detailed)
        }
        _ => None,
    }
}

/// Normalize a raw string to an [`ElevatedLevel`].
pub fn normalize_elevated_level(raw: &str) -> Option<ElevatedLevel> {
    match raw.to_lowercase().as_str() {
        "off" | "false" | "no" | "0" | "disable" | "disabled" => Some(ElevatedLevel::Off),
        "on" | "true" | "yes" | "1" | "full" | "auto" | "auto-approve" | "autoapprove" | "ask"
        | "prompt" => Some(ElevatedLevel::On),
        _ => None,
    }
}

/// Normalize a raw exec argument to an [`ExecConfig`].
pub fn normalize_exec(raw: &str) -> Option<ExecConfig> {
    match raw.to_lowercase().as_str() {
        "off" | "false" | "no" | "disable" | "disabled" => Some(ExecConfig {
            enabled: false,
            auto_approve: false,
        }),
        "on" | "true" | "yes" | "enable" | "enabled" => Some(ExecConfig {
            enabled: true,
            auto_approve: false,
        }),
        "auto-approve" | "auto_approve" | "autoapprove" | "approve" | "auto" => Some(ExecConfig {
            enabled: true,
            auto_approve: true,
        }),
        _ => None,
    }
}

// ============================================================================
// Public Extract Functions
// ============================================================================

/// Extract a `/think` (or `/thinking`, `/t`) directive from `text`.
pub fn extract_think_directive(text: &str) -> Option<ThinkLevel> {
    extract_level(text, &["thinking", "think", "t"], normalize_think_level).level
}

/// Extract a `/verbose` (or `/v`) directive from `text`.
pub fn extract_verbose_directive(text: &str) -> Option<VerboseLevel> {
    extract_level(text, &["verbose", "v"], normalize_verbose_level).level
}

/// Extract a `/reasoning` (or `/reason`) directive from `text`.
pub fn extract_reasoning_directive(text: &str) -> Option<ReasoningLevel> {
    extract_level(text, &["reasoning", "reason"], normalize_reasoning_level).level
}

/// Extract an `/elevated` (or `/elev`) directive from `text`.
pub fn extract_elevated_directive(text: &str) -> Option<ElevatedLevel> {
    extract_level(text, &["elevated", "elev"], normalize_elevated_level).level
}

/// Extract an `/exec` directive from `text`.
pub fn extract_exec_directive(text: &str) -> Option<ExecConfig> {
    let result = extract_level(text, &["exec"], normalize_exec);
    if result.found && result.level.is_none() {
        // Bare /exec with no argument → enabled with no auto-approve
        Some(ExecConfig {
            enabled: true,
            auto_approve: false,
        })
    } else {
        result.level
    }
}

/// Extract a `/model` directive from `text`.
///
/// Model arguments allow `/` and `.` in addition to the standard characters.
pub fn extract_model_directive(text: &str) -> Option<ModelConfig> {
    let result = find_model_match(text);
    result.and_then(|(cfg, _, _)| cfg)
}

/// Return `true` if `text` contains a `/status` directive.
pub fn extract_status_directive(text: &str) -> bool {
    find_directive_match(text, &["status"]).is_some()
}

// ============================================================================
// Model-Specific Matching (allows `/` and `.` in argument)
// ============================================================================

/// Locate a `/model` directive and parse its argument into a [`ModelConfig`].
///
/// Returns `(Option<ModelConfig>, match_start, match_end)` or `None` when the
/// directive is absent.
fn find_model_match(text: &str) -> Option<(Option<ModelConfig>, usize, usize)> {
    let re = Regex::new(r"(?i)(?:^|\s)/model").unwrap();

    for mat in re.find_iter(text) {
        let name_end = mat.end();

        if !is_valid_boundary(text, name_end) {
            continue;
        }

        let bytes = text.as_bytes();
        let mut i = name_end;

        // skip whitespace
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        // optional colon
        if i < bytes.len() && bytes[i] == b':' {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
        }
        // read model spec  [a-zA-Z0-9_.\-/]+
        let arg_start = i;
        while i < bytes.len()
            && (bytes[i].is_ascii_alphanumeric()
                || bytes[i] == b'-'
                || bytes[i] == b'_'
                || bytes[i] == b'.'
                || bytes[i] == b'/')
        {
            i += 1;
        }

        let config = if i > arg_start {
            let raw = &text[arg_start..i];
            let parts: Vec<&str> = raw.splitn(2, '/').collect();
            if parts.len() == 2 {
                Some(ModelConfig {
                    provider: Some(parts[0].to_string()),
                    model: Some(parts[1].to_string()),
                    temperature: None,
                })
            } else {
                Some(ModelConfig {
                    provider: None,
                    model: Some(parts[0].to_string()),
                    temperature: None,
                })
            }
        } else {
            None
        };

        return Some((config, mat.start(), i));
    }

    None
}

// ============================================================================
// Combined Parser
// ============================================================================

/// Parse **all** inline directives from `text`, returning a [`ParsedDirectives`]
/// with cleaned text and flags for each recognised directive.
pub fn parse_all_directives(text: &str) -> ParsedDirectives {
    // --- 1. think ---
    let think_res = extract_level(text, &["thinking", "think", "t"], normalize_think_level);
    let after_think = &think_res.cleaned;

    // --- 2. verbose ---
    let verbose_res = extract_level(after_think, &["verbose", "v"], normalize_verbose_level);
    let after_verbose = &verbose_res.cleaned;

    // --- 3. reasoning ---
    let reasoning_res =
        extract_level(after_verbose, &["reasoning", "reason"], normalize_reasoning_level);
    let after_reasoning = &reasoning_res.cleaned;

    // --- 4. elevated ---
    let elevated_res =
        extract_level(after_reasoning, &["elevated", "elev"], normalize_elevated_level);
    let after_elevated = &elevated_res.cleaned;

    // --- 5. exec ---
    let exec_res: ExtractResult<ExecConfig> =
        extract_level(after_elevated, &["exec"], normalize_exec);
    let exec_found = exec_res.found;
    let exec_config = if exec_found && exec_res.level.is_none() {
        Some(ExecConfig {
            enabled: true,
            auto_approve: false,
        })
    } else {
        exec_res.level
    };
    let after_exec = &exec_res.cleaned;

    // --- 6. status ---
    let status_res: ExtractResult<()> = {
        if let Some(dm) = find_directive_match(after_exec, &["status"]) {
            let cleaned = clean_text(after_exec, dm.start, dm.end);
            ExtractResult {
                found: true,
                level: None,
                cleaned,
            }
        } else {
            ExtractResult {
                found: false,
                level: None,
                cleaned: after_exec.trim().to_string(),
            }
        }
    };
    let after_status = &status_res.cleaned;

    // --- 7. model ---
    let (model_found, model_config, after_model) = {
        if let Some((cfg, start, end)) = find_model_match(after_status) {
            let cleaned = clean_text(after_status, start, end);
            (true, cfg, cleaned)
        } else {
            (false, None, after_status.trim().to_string())
        }
    };

    // directives_only: at least one directive found AND cleaned text is empty.
    let any_directive = think_res.found
        || verbose_res.found
        || reasoning_res.found
        || elevated_res.found
        || exec_found
        || model_found;
    let directives_only = any_directive && after_model.trim().is_empty();

    ParsedDirectives {
        cleaned_text: after_model,
        directives_only,
        has_think: think_res.found,
        think: think_res.level,
        has_verbose: verbose_res.found,
        verbose: verbose_res.level,
        has_reasoning: reasoning_res.found,
        reasoning: reasoning_res.level,
        has_elevated: elevated_res.found,
        elevated: elevated_res.level,
        has_exec: exec_found,
        exec: exec_config,
        has_model: model_found,
        model: model_config,
        has_status: status_res.found,
    }
}

/// Remove all recognised directive markers from `text`, returning the cleaned
/// message content.
pub fn strip_directives(text: &str) -> String {
    parse_all_directives(text).cleaned_text
}

/// Build a human-readable summary of a [`DirectiveState`].
pub fn format_directive_state(state: &DirectiveState) -> String {
    let mut lines = vec![
        format!("Thinking: {}", state.thinking),
        format!("Verbose: {}", state.verbose),
        format!("Reasoning: {}", state.reasoning),
        format!("Elevated: {}", state.elevated),
    ];
    if state.model.provider.is_some() || state.model.model.is_some() {
        let model_str = match (&state.model.provider, &state.model.model) {
            (Some(p), Some(m)) => format!("{}/{}", p, m),
            (None, Some(m)) => m.clone(),
            _ => "unknown".to_string(),
        };
        lines.push(format!("Model: {}", model_str));
    }
    if state.exec.enabled {
        lines.push(format!(
            "Exec: enabled (auto_approve={})",
            state.exec.auto_approve
        ));
    }
    lines.join("\n")
}

/// Apply a set of [`ParsedDirectives`] on top of an existing [`DirectiveState`],
/// returning the updated state.
pub fn apply_directives(current: &DirectiveState, directives: &ParsedDirectives) -> DirectiveState {
    let mut updated = current.clone();

    if let Some(level) = directives.think {
        updated.thinking = level;
    }
    if let Some(level) = directives.verbose {
        updated.verbose = level;
    }
    if let Some(level) = directives.reasoning {
        updated.reasoning = level;
    }
    if let Some(level) = directives.elevated {
        updated.elevated = level;
    }
    if let Some(ref cfg) = directives.exec {
        updated.exec = cfg.clone();
    }
    if let Some(ref cfg) = directives.model {
        updated.model = cfg.clone();
    }

    updated
}
