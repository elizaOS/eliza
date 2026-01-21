//! # ELIZA Classic Plugin
//!
//! A Rust implementation of the classic ELIZA chatbot, originally created by
//! Joseph Weizenbaum at MIT in 1966. ELIZA simulates a Rogerian psychotherapist
//! by using pattern matching and substitution to transform user input into
//! therapeutic-sounding responses.
//!
//! ## Features
//!
//! - Pattern-based response generation
//! - Pronoun reflection (e.g., "I am" → "you are")
//! - Configurable patterns and responses
//! - Response history to avoid repetition
//!
//! ## Example
//!
//! ```rust
//! use elizaos_plugin_eliza_classic::ElizaClassicPlugin;
//!
//! let eliza = ElizaClassicPlugin::new();
//! println!("{}", eliza.get_greeting());
//! let response = eliza.generate_response("I am feeling sad today");
//! println!("{}", response);
//! ```

#![warn(missing_docs)]

pub mod actions;
pub mod doctor_script;
pub mod interop;
pub mod patterns;
pub mod providers;
pub mod types;

use std::sync::Mutex;

use std::collections::{HashMap, VecDeque};
pub use types::{ElizaConfig, ElizaPattern, ElizaRule};

use doctor_script::{load_doctor_script, DoctorScript, KeywordEntry, ScriptRule};
use lazy_static::lazy_static;

#[derive(Debug, Clone)]
enum Token {
    Wildcard,
    Literal(String),
    Alt(Vec<String>),
    Group(String),
}

#[derive(Debug, Default)]
struct SessionState {
    limit: u8, // 1..4
    memories: VecDeque<String>,
    reassembly_index: HashMap<String, usize>,
}

lazy_static! {
    static ref SCRIPT: DoctorScript = load_doctor_script();
    static ref KEYWORD_INDEX: HashMap<String, usize> = {
        let mut m = HashMap::new();
        for (idx, entry) in SCRIPT.keywords.iter().enumerate() {
            for k in &entry.keyword {
                m.insert(k.to_lowercase(), idx);
            }
        }
        m
    };
}

/// Reflects pronouns in the input text to transform perspective.
///
/// This function converts first-person pronouns to second-person and vice versa,
/// which is essential for ELIZA's response generation (e.g., "I am sad" becomes
/// "you are sad").
///
/// # Arguments
///
/// * `text` - The input text to reflect
///
/// # Returns
///
/// A new string with pronouns reflected
pub fn reflect(text: &str) -> String {
    text.to_lowercase()
        .split_whitespace()
        .map(|word| {
            SCRIPT
                .reflections
                .get(word)
                .map(|s| s.as_str())
                .unwrap_or(word)
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_raw_input(input: &str) -> String {
    input
        .trim()
        .replace(['!', '?', ';', ':'], " ")
        .replace(['\u{2018}', '\u{2019}'], "'")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn extract_user_message(prompt: &str) -> String {
    // Mirror TS behavior: if prompt contains "User:"/"Human:"/"You:" lines, extract the first.
    let re = regex::Regex::new(r"(?i)(?:User|Human|You):\s*(.+?)(?:\n|$)").expect("regex ok");
    if let Some(caps) = re.captures(prompt) {
        if let Some(m) = caps.get(1) {
            return m.as_str().trim().to_string();
        }
    }
    prompt.trim().to_string()
}

fn tokenize_words(text: &str) -> Vec<String> {
    let cleaned = normalize_raw_input(text)
        .replace(['.', ',', '"', '(', ')'], " ")
        .to_lowercase();
    if cleaned.trim().is_empty() {
        return Vec::new();
    }
    // Keep scan/tokenization close to the TS implementation:
    // only canonicalize a small subset (punctuation/orthography), not full ELIZA substitutions.
    const CANON_KEYS: [&str; 7] = ["dont", "cant", "wont", "dreamed", "dreams", "mom", "dad"];
    cleaned
        .split_whitespace()
        .map(|w| {
            let w = w.to_string();
            if CANON_KEYS.contains(&w.as_str()) {
                SCRIPT
                    .substitutions
                    .get(&w)
                    .cloned()
                    .or_else(|| SCRIPT.reflections.get(&w).cloned())
                    .unwrap_or(w)
            } else {
                w
            }
        })
        .collect()
}

fn tokenize_for_scan(input: &str) -> Vec<String> {
    let cleaned = normalize_raw_input(input)
        .replace([',', '.'], " | ")
        .replace(['"', '(', ')'], " ")
        .to_lowercase();
    if cleaned.trim().is_empty() {
        return Vec::new();
    }
    const CANON_KEYS: [&str; 7] = ["dont", "cant", "wont", "dreamed", "dreams", "mom", "dad"];
    cleaned
        .split_whitespace()
        .map(|w| {
            let w = w.to_string();
            if CANON_KEYS.contains(&w.as_str()) {
                SCRIPT
                    .substitutions
                    .get(&w)
                    .cloned()
                    .or_else(|| SCRIPT.reflections.get(&w).cloned())
                    .unwrap_or(w)
            } else {
                w
            }
        })
        .collect()
}

fn split_into_clauses(words: &[String]) -> Vec<Vec<String>> {
    let mut clauses: Vec<Vec<String>> = Vec::new();
    let mut current: Vec<String> = Vec::new();
    for w in words {
        if w == "|" || w == "but" {
            if !current.is_empty() {
                clauses.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(w.clone());
    }
    if !current.is_empty() {
        clauses.push(current);
    }
    clauses
}

fn substitute_words_for_matching(words: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for w in words {
        let key = w.to_lowercase();
        let mapped = SCRIPT
            .substitutions
            .get(&key)
            .cloned()
            .or_else(|| SCRIPT.reflections.get(&key).cloned());
        match mapped {
            None => out.push(key),
            Some(m) => {
                let parts = m
                    .to_lowercase()
                    .split_whitespace()
                    .filter(|p| !p.is_empty())
                    .map(|p| p.to_string())
                    .collect::<Vec<_>>();
                if parts.is_empty() {
                    out.push(key);
                } else {
                    out.extend(parts);
                }
            }
        }
    }
    out
}

#[derive(Debug)]
struct FoundKeyword {
    keyword: String,
    entry_idx: usize,
    precedence: i32,
    position: usize,
}

fn select_keyword_stack(scan_words: &[String]) -> (Vec<FoundKeyword>, Vec<String>) {
    for clause in split_into_clauses(scan_words) {
        let mut found: Vec<FoundKeyword> = Vec::new();
        for (i, w) in clause.iter().enumerate() {
            if let Some(&entry_idx) = KEYWORD_INDEX.get(w) {
                let precedence = SCRIPT
                    .keywords
                    .get(entry_idx)
                    .map(|e| e.precedence)
                    .unwrap_or(0);
                found.push(FoundKeyword {
                    keyword: w.clone(),
                    entry_idx,
                    precedence,
                    position: i,
                });
            }
        }
        if !found.is_empty() {
            found.sort_by(|a, b| {
                b.precedence
                    .cmp(&a.precedence)
                    .then_with(|| a.position.cmp(&b.position))
            });
            return (found, clause);
        }
    }
    (Vec::new(), Vec::new())
}

fn parse_decomposition(pattern: &str) -> Vec<Token> {
    let raw = pattern.split_whitespace().collect::<Vec<_>>().join(" ");
    let raw = raw.to_lowercase();
    if raw.is_empty() {
        return Vec::new();
    }

    let mut tokens: Vec<Token> = Vec::new();
    let mut i = 0usize;
    let chars: Vec<char> = raw.chars().collect();
    while i < chars.len() {
        while i < chars.len() && chars[i] == ' ' {
            i += 1;
        }
        if i >= chars.len() {
            break;
        }
        match chars[i] {
            '*' => {
                tokens.push(Token::Wildcard);
                i += 1;
            }
            '@' => {
                let start = i + 1;
                let mut j = start;
                while j < chars.len() && chars[j] != ' ' {
                    j += 1;
                }
                let group = chars[start..j].iter().collect::<String>();
                if !group.is_empty() {
                    tokens.push(Token::Group(group));
                }
                i = j;
            }
            '[' => {
                let start = i + 1;
                let mut j = start;
                while j < chars.len() && chars[j] != ']' {
                    j += 1;
                }
                if j >= chars.len() {
                    let rest = chars[i..].iter().collect::<String>().trim().to_string();
                    if !rest.is_empty() {
                        tokens.push(Token::Literal(rest));
                    }
                    break;
                }
                let inside = chars[start..j].iter().collect::<String>();
                let options = inside
                    .split_whitespace()
                    .filter(|p| !p.is_empty())
                    .map(|p| p.to_string())
                    .collect::<Vec<_>>();
                tokens.push(Token::Alt(options));
                i = j + 1;
            }
            _ => {
                let start = i;
                let mut j = start;
                while j < chars.len() && chars[j] != ' ' {
                    j += 1;
                }
                let w = chars[start..j]
                    .iter()
                    .collect::<String>()
                    .trim()
                    .to_string();
                if !w.is_empty() {
                    tokens.push(Token::Literal(w));
                }
                i = j;
            }
        }
    }
    tokens
}

fn token_matches_word(token: &Token, word: &str) -> bool {
    match token {
        Token::Literal(v) => v == word,
        Token::Alt(options) => options.iter().any(|o| o == word),
        Token::Group(group) => SCRIPT
            .groups
            .get(group)
            .map(|ws| ws.iter().any(|w| w == word))
            .unwrap_or(false),
        Token::Wildcard => false,
    }
}

fn match_decomposition(tokens: &[Token], words: &[String]) -> Option<Vec<String>> {
    let mut parts = vec![String::new(); tokens.len()];

    fn backtrack(
        tokens: &[Token],
        words: &[String],
        parts: &mut [String],
        ti: usize,
        wi: usize,
    ) -> bool {
        if ti == tokens.len() {
            return wi == words.len();
        }
        match &tokens[ti] {
            Token::Wildcard => {
                for end in wi..=words.len() {
                    parts[ti] = words[wi..end].join(" ").trim().to_string();
                    if backtrack(tokens, words, parts, ti + 1, end) {
                        return true;
                    }
                }
                false
            }
            token => {
                if wi >= words.len() {
                    return false;
                }
                let w = &words[wi];
                if !token_matches_word(token, w) {
                    return false;
                }
                parts[ti] = w.clone();
                backtrack(tokens, words, parts, ti + 1, wi + 1)
            }
        }
    }

    if backtrack(tokens, words, &mut parts, 0, 0) {
        Some(parts)
    } else {
        None
    }
}

fn apply_reassembly(template: &str, parts: &[String]) -> String {
    let mut out = template.to_string();
    for i in 1..=parts.len() {
        let placeholder = format!("${}", i);
        if out.contains(&placeholder) {
            let reflected = reflect(parts[i - 1].as_str());
            out = out.replace(&placeholder, &reflected);
        }
    }
    // any leftover $N
    let re = regex::Regex::new(r"\$\d+").expect("regex ok");
    re.replace_all(&out, "that").to_string()
}

fn stable_key_for_rule(keyword: &str, rule: &ScriptRule, rule_index: usize) -> String {
    format!("{}::{}::{}", keyword, rule_index, rule.decomposition)
}

fn pick_next_reassembly(
    session: &mut SessionState,
    keyword: &str,
    rule: &ScriptRule,
    rule_index: usize,
) -> String {
    let key = stable_key_for_rule(keyword, rule, rule_index);
    let current = *session.reassembly_index.get(&key).unwrap_or(&0);
    let idx = if rule.reassembly.is_empty() {
        0
    } else {
        current % rule.reassembly.len()
    };
    session
        .reassembly_index
        .insert(key, (current + 1) % std::cmp::max(1, rule.reassembly.len()));
    rule.reassembly.get(idx).cloned().unwrap_or_default()
}

fn compute_word_hash(word: &str) -> u32 {
    let mut h: u32 = 0;
    for ch in word.chars() {
        h = h.wrapping_mul(31).wrapping_add(ch as u32);
    }
    h
}

fn choose_default_response(session: &mut SessionState) -> String {
    if session.limit == 4 {
        if let Some(m) = session.memories.pop_front() {
            return m;
        }
    }
    let idx = *session.reassembly_index.get("__default__").unwrap_or(&0);
    session
        .reassembly_index
        .insert("__default__".to_string(), idx + 1);
    SCRIPT
        .default_responses
        .get(idx % SCRIPT.default_responses.len())
        .cloned()
        .unwrap_or_else(|| "Please go on.".to_string())
}

fn is_goodbye(words: &[String]) -> bool {
    let first = match words.first() {
        None => return false,
        Some(w) => w,
    };
    SCRIPT
        .goodbyes
        .iter()
        .filter_map(|g| tokenize_words(g).first().cloned())
        .any(|w| w == *first)
}

fn resolve_redirect_keyword(s: &str) -> Option<String> {
    let trimmed = s.trim();
    if !trimmed.starts_with('=') {
        return None;
    }
    let k = trimmed[1..].trim().to_lowercase();
    if k.is_empty() {
        None
    } else {
        Some(k)
    }
}

fn is_newkey_directive(s: &str) -> bool {
    let t = s.trim().to_lowercase();
    t == ":newkey" || t == "newkey"
}

fn parse_pre_directive(s: &str) -> Option<(String, String)> {
    // ":pre <text> (=keyword)"
    let t = s.trim();
    let lower = t.to_lowercase();
    if !lower.starts_with(":pre ") {
        return None;
    }
    // find "(=" ... ")"
    let open = t.rfind("(=")?;
    let close = t.rfind(')')?;
    if close <= open + 2 {
        return None;
    }
    let pre_text = t[5..open].trim().to_string();
    let redirect = t[open + 2..close].trim().to_lowercase();
    if pre_text.is_empty() || redirect.is_empty() {
        None
    } else {
        Some((pre_text, redirect))
    }
}

#[derive(Debug)]
enum RuleEvalResult {
    NoMatch,
    NewKey,
    Redirect(String),
    Pre {
        pre_text: String,
        redirect: String,
        parts: Vec<String>,
    },
    Response(String),
}

fn try_rules_for_keyword(
    session: &mut SessionState,
    keyword: &str,
    entry: &KeywordEntry,
    words: &[String],
) -> RuleEvalResult {
    for (i, rule) in entry.rules.iter().enumerate() {
        let tokens = parse_decomposition(&rule.decomposition);
        let parts = match match_decomposition(&tokens, words) {
            None => continue,
            Some(p) => p,
        };
        let picked = pick_next_reassembly(session, keyword, rule, i);
        if is_newkey_directive(&picked) {
            return RuleEvalResult::NewKey;
        }
        if let Some((pre_text, redirect)) = parse_pre_directive(&picked) {
            return RuleEvalResult::Pre {
                pre_text,
                redirect,
                parts,
            };
        }
        if let Some(r) = resolve_redirect_keyword(&picked) {
            return RuleEvalResult::Redirect(r);
        }
        return RuleEvalResult::Response(apply_reassembly(&picked, &parts));
    }
    RuleEvalResult::NoMatch
}

fn maybe_record_memory(session: &mut SessionState, entry: &KeywordEntry, words: &[String]) {
    if entry.memory.is_empty() {
        return;
    }
    let last = words.last().cloned().unwrap_or_default();
    let chosen_idx = if entry.memory.is_empty() {
        0
    } else {
        (compute_word_hash(&last) as usize) % entry.memory.len()
    };
    let chosen = match entry.memory.get(chosen_idx) {
        None => return,
        Some(r) => r,
    };
    let tokens = parse_decomposition(&chosen.decomposition);
    let parts = match match_decomposition(&tokens, words) {
        None => return,
        Some(p) => p,
    };
    let response_idx = if chosen.reassembly.is_empty() {
        0
    } else {
        (compute_word_hash(&last) as usize) % chosen.reassembly.len()
    };
    let template = chosen
        .reassembly
        .get(response_idx)
        .or_else(|| chosen.reassembly.first())
        .cloned()
        .unwrap_or_default();
    let response = apply_reassembly(&template, &parts);
    if !response.trim().is_empty() {
        session.memories.push_back(response);
    }
}

/// The main ELIZA chatbot plugin struct.
///
/// This struct encapsulates all the state and logic needed to simulate
/// an ELIZA conversation, including pattern matching rules, default responses,
/// and response history tracking.
pub struct ElizaClassicPlugin {
    state: Mutex<SessionState>,
}

impl Default for ElizaClassicPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl ElizaClassicPlugin {
    /// Creates a new ELIZA plugin instance with default patterns and responses.
    ///
    /// # Returns
    ///
    /// A new `ElizaClassicPlugin` with the standard ELIZA patterns and responses.
    pub fn new() -> Self {
        Self {
            state: Mutex::new(SessionState {
                limit: 1,
                ..SessionState::default()
            }),
        }
    }

    /// Creates a new ELIZA plugin instance with custom configuration.
    ///
    /// # Arguments
    ///
    /// * `config` - Custom configuration including additional patterns and responses
    ///
    /// # Returns
    ///
    /// A new `ElizaClassicPlugin` configured with the provided settings.
    pub fn with_config(config: ElizaConfig) -> Self {
        let _ = config;
        // This implementation is script-driven; custom patterns/defaults are ignored for now
        // to keep parity with the canonical DOCTOR script across languages.
        Self::new()
    }

    /// Generates a response to the user's input using ELIZA's pattern matching.
    ///
    /// The method normalizes the input, searches for matching patterns,
    /// applies pronoun reflection to captured groups, and returns an
    /// appropriate therapeutic response.
    ///
    /// # Arguments
    ///
    /// * `input` - The user's input text
    ///
    /// # Returns
    ///
    /// A response string generated based on pattern matching or a default response.
    pub fn generate_response(&self, input: &str) -> String {
        let extracted = extract_user_message(input);
        let words = tokenize_words(&extracted);
        let scan_words = tokenize_for_scan(&extracted);

        let mut state = self.state.lock().expect("state lock");
        state.limit = if state.limit == 4 { 1 } else { state.limit + 1 };

        if words.is_empty() {
            return choose_default_response(&mut state);
        }
        if is_goodbye(&words) {
            return SCRIPT
                .goodbyes
                .first()
                .cloned()
                .unwrap_or_else(|| "Goodbye.".to_string());
        }

        let (stack, clause_words) = select_keyword_stack(&scan_words);
        if stack.is_empty() || clause_words.is_empty() {
            return choose_default_response(&mut state);
        }

        let match_words = substitute_words_for_matching(&clause_words);

        for found in stack {
            let entry = match SCRIPT.keywords.get(found.entry_idx) {
                None => continue,
                Some(e) => e,
            };

            maybe_record_memory(&mut state, entry, &match_words);

            match try_rules_for_keyword(&mut state, &found.keyword, entry, &match_words) {
                RuleEvalResult::NoMatch => continue,
                RuleEvalResult::NewKey => continue,
                RuleEvalResult::Response(text) => return text,
                RuleEvalResult::Redirect(k) => {
                    let idx = match KEYWORD_INDEX.get(&k) {
                        None => continue,
                        Some(i) => *i,
                    };
                    let redirected = &SCRIPT.keywords[idx];
                    match try_rules_for_keyword(&mut state, &k, redirected, &match_words) {
                        RuleEvalResult::Response(text) => return text,
                        _ => continue,
                    }
                }
                RuleEvalResult::Pre {
                    pre_text,
                    redirect,
                    parts,
                } => {
                    let pre_applied = apply_reassembly(&pre_text, &parts);
                    let pre_words = tokenize_words(&pre_applied);
                    let idx = match KEYWORD_INDEX.get(&redirect) {
                        None => continue,
                        Some(i) => *i,
                    };
                    let redirected = &SCRIPT.keywords[idx];
                    match try_rules_for_keyword(&mut state, &redirect, redirected, &pre_words) {
                        RuleEvalResult::Response(text) => return text,
                        _ => continue,
                    }
                }
            }
        }

        choose_default_response(&mut state)
    }

    /// Returns ELIZA's greeting message to start a conversation.
    ///
    /// # Returns
    ///
    /// A greeting string introducing ELIZA as a Rogerian psychotherapist.
    pub fn get_greeting(&self) -> String {
        SCRIPT
            .greetings
            .get(1)
            .or_else(|| SCRIPT.greetings.first())
            .cloned()
            .unwrap_or_else(|| "How do you do? Please tell me your problem".to_string())
    }

    /// Clears the response history.
    ///
    /// This allows previously used responses to be selected again,
    /// useful for starting fresh conversations.
    pub fn reset_history(&self) {
        let mut state = self.state.lock().expect("state lock");
        *state = SessionState {
            limit: 1,
            ..SessionState::default()
        };
    }
}

/// Generates a response using a shared global ELIZA instance.
///
/// This is a convenience function that uses a lazily-initialized global
/// `ElizaClassicPlugin` instance. Useful for simple use cases where
/// custom configuration is not needed.
///
/// # Arguments
///
/// * `input` - The user's input text
///
/// # Returns
///
/// A response string generated by the global ELIZA instance.
pub fn generate_response(input: &str) -> String {
    lazy_static! {
        static ref PLUGIN: ElizaClassicPlugin = ElizaClassicPlugin::new();
    }
    PLUGIN.generate_response(input)
}

/// Returns the standard ELIZA greeting message.
///
/// # Returns
///
/// A greeting string introducing ELIZA as a Rogerian psychotherapist.
pub fn get_greeting() -> String {
    SCRIPT
        .greetings
        .get(1)
        .or_else(|| SCRIPT.greetings.first())
        .cloned()
        .unwrap_or_else(|| "How do you do? Please tell me your problem".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_reflect() {
        assert_eq!(reflect("i am happy"), "you are happy");
        assert_eq!(reflect("my car"), "your car");
    }

    #[test]
    fn test_greeting() {
        let plugin = ElizaClassicPlugin::new();
        let greeting = plugin.get_greeting();
        assert!(greeting.to_lowercase().contains("problem"));
    }

    #[test]
    fn test_generate_response() {
        let plugin = ElizaClassicPlugin::new();
        let response = plugin.generate_response("hello");
        assert!(!response.is_empty());
    }

    #[test]
    fn test_empty_input() {
        let plugin = ElizaClassicPlugin::new();
        let response = plugin.generate_response("");
        assert!(!response.is_empty());
    }

    #[test]
    fn test_sad_response() {
        let plugin = ElizaClassicPlugin::new();
        let response = plugin.generate_response("I am sad");
        assert!(!response.is_empty());
    }

    #[test]
    fn test_computer_response() {
        let plugin = ElizaClassicPlugin::new();
        let response = plugin.generate_response("I think computers are fascinating");
        assert_eq!(response, "Do computers worry you?");
    }
}
