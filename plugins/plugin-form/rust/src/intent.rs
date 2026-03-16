//! Two-tier intent detection for form interactions.
//!
//! Tier 1 (fast path): Regex-based English keyword matching (<1ms, deterministic).
//! Tier 2 (LLM fallback): Used when fast path returns None.

use crate::types::FormIntent;
use regex::Regex;
use std::sync::LazyLock;

// ============================================================================
// COMPILED REGEX PATTERNS
// ============================================================================

static RE_RESTORE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(resume|continue|pick up where|go back to|get back to)\b").unwrap()
});

static RE_SUBMIT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(submit|done|finish|send it|that'?s all|i'?m done|complete|all set)\b")
        .unwrap()
});

static RE_STASH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(save|stash|later|hold on|pause|save for later|come back|save this)\b",
    )
    .unwrap()
});

static RE_STASH_EXCLUDE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(save and submit|save and send)\b").unwrap()
});

static RE_CANCEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(cancel|abort|nevermind|never mind|forget it|stop|quit|exit)\b",
    )
    .unwrap()
});

static RE_UNDO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(undo|go back|wait no|change that|oops|that'?s wrong|wrong|not right)\b",
    )
    .unwrap()
});

static RE_SKIP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(skip|pass|don'?t know|next one|next|don'?t have|no idea)\b").unwrap()
});

static RE_SKIP_EXCLUDE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bskip to\b").unwrap());

static RE_EXPLAIN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(why|what'?s that for|explain|what do you mean|what is|purpose|reason)\b\??$",
    )
    .unwrap()
});

static RE_EXPLAIN_STANDALONE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^why\??$").unwrap());

static RE_EXAMPLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(example|like what|show me|such as|for instance|sample)\b\??$").unwrap()
});

static RE_EXAMPLE_STANDALONE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(example|e\.?g\.?)\??$").unwrap());

static RE_PROGRESS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(how far|how many left|progress|status|how much more|where are we)\b",
    )
    .unwrap()
});

static RE_AUTOFILL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(same as|last time|use my usual|like before|previous|from before)\b",
    )
    .unwrap()
});

// ============================================================================
// QUICK INTENT DETECTION
// ============================================================================

/// Quick intent detection using English keywords.
///
/// Fast path for common English phrases. Returns `None` if no match,
/// signaling the caller to use LLM fallback.
pub fn quick_intent_detect(text: &str) -> Option<FormIntent> {
    let lower = text.to_lowercase();
    let trimmed = lower.trim();

    // Empty or too short
    if trimmed.len() < 2 {
        return None;
    }

    // ═══ LIFECYCLE INTENTS ═══

    // Restore
    if RE_RESTORE.is_match(trimmed) {
        return Some(FormIntent::Restore);
    }

    // Submit
    if RE_SUBMIT.is_match(trimmed) {
        return Some(FormIntent::Submit);
    }

    // Stash (but not "save and submit")
    if RE_STASH.is_match(trimmed) && !RE_STASH_EXCLUDE.is_match(trimmed) {
        return Some(FormIntent::Stash);
    }

    // Cancel
    if RE_CANCEL.is_match(trimmed) {
        return Some(FormIntent::Cancel);
    }

    // ═══ UX MAGIC INTENTS ═══

    // Undo
    if RE_UNDO.is_match(trimmed) {
        return Some(FormIntent::Undo);
    }

    // Skip (but not "skip to")
    if RE_SKIP.is_match(trimmed) && !RE_SKIP_EXCLUDE.is_match(trimmed) {
        return Some(FormIntent::Skip);
    }

    // Explain
    if RE_EXPLAIN.is_match(trimmed) || RE_EXPLAIN_STANDALONE.is_match(trimmed) {
        return Some(FormIntent::Explain);
    }

    // Example
    if RE_EXAMPLE.is_match(trimmed) || RE_EXAMPLE_STANDALONE.is_match(trimmed) {
        return Some(FormIntent::Example);
    }

    // Progress
    if RE_PROGRESS.is_match(trimmed) {
        return Some(FormIntent::Progress);
    }

    // Autofill
    if RE_AUTOFILL.is_match(trimmed) {
        return Some(FormIntent::Autofill);
    }

    None
}

// ============================================================================
// INTENT HELPERS
// ============================================================================

/// Check if intent is a lifecycle intent (affects session state).
pub fn is_lifecycle_intent(intent: &FormIntent) -> bool {
    matches!(
        intent,
        FormIntent::Submit | FormIntent::Stash | FormIntent::Restore | FormIntent::Cancel
    )
}

/// Check if intent is a UX intent (helper action, no data).
pub fn is_ux_intent(intent: &FormIntent) -> bool {
    matches!(
        intent,
        FormIntent::Undo
            | FormIntent::Skip
            | FormIntent::Explain
            | FormIntent::Example
            | FormIntent::Progress
            | FormIntent::Autofill
    )
}

/// Check if intent likely contains data to extract.
pub fn has_data_to_extract(intent: &FormIntent) -> bool {
    matches!(intent, FormIntent::FillForm | FormIntent::Other)
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ═══ SUBMIT ═══

    #[test]
    fn test_submit_keyword() {
        assert_eq!(quick_intent_detect("submit"), Some(FormIntent::Submit));
    }

    #[test]
    fn test_done_keyword() {
        assert_eq!(quick_intent_detect("done"), Some(FormIntent::Submit));
    }

    #[test]
    fn test_finish_keyword() {
        assert_eq!(quick_intent_detect("finish"), Some(FormIntent::Submit));
    }

    #[test]
    fn test_send_it_keyword() {
        assert_eq!(quick_intent_detect("send it"), Some(FormIntent::Submit));
    }

    #[test]
    fn test_thats_all_keyword() {
        assert_eq!(quick_intent_detect("that's all"), Some(FormIntent::Submit));
    }

    #[test]
    fn test_im_done_keyword() {
        assert_eq!(quick_intent_detect("i'm done"), Some(FormIntent::Submit));
    }

    #[test]
    fn test_complete_keyword() {
        assert_eq!(quick_intent_detect("complete"), Some(FormIntent::Submit));
    }

    #[test]
    fn test_all_set_keyword() {
        assert_eq!(quick_intent_detect("all set"), Some(FormIntent::Submit));
    }

    // ═══ CANCEL ═══

    #[test]
    fn test_cancel_keyword() {
        assert_eq!(quick_intent_detect("cancel"), Some(FormIntent::Cancel));
    }

    #[test]
    fn test_abort_keyword() {
        assert_eq!(quick_intent_detect("abort"), Some(FormIntent::Cancel));
    }

    #[test]
    fn test_nevermind_keyword() {
        assert_eq!(quick_intent_detect("nevermind"), Some(FormIntent::Cancel));
    }

    #[test]
    fn test_never_mind_keyword() {
        assert_eq!(quick_intent_detect("never mind"), Some(FormIntent::Cancel));
    }

    #[test]
    fn test_forget_it_keyword() {
        assert_eq!(quick_intent_detect("forget it"), Some(FormIntent::Cancel));
    }

    #[test]
    fn test_stop_keyword() {
        assert_eq!(quick_intent_detect("stop"), Some(FormIntent::Cancel));
    }

    #[test]
    fn test_quit_keyword() {
        assert_eq!(quick_intent_detect("quit"), Some(FormIntent::Cancel));
    }

    #[test]
    fn test_exit_keyword() {
        assert_eq!(quick_intent_detect("exit"), Some(FormIntent::Cancel));
    }

    // ═══ STASH ═══

    #[test]
    fn test_save_keyword() {
        assert_eq!(quick_intent_detect("save"), Some(FormIntent::Stash));
    }

    #[test]
    fn test_stash_keyword() {
        assert_eq!(quick_intent_detect("stash"), Some(FormIntent::Stash));
    }

    #[test]
    fn test_later_keyword() {
        assert_eq!(quick_intent_detect("later"), Some(FormIntent::Stash));
    }

    #[test]
    fn test_pause_keyword() {
        assert_eq!(quick_intent_detect("pause"), Some(FormIntent::Stash));
    }

    #[test]
    fn test_save_for_later() {
        assert_eq!(
            quick_intent_detect("save for later"),
            Some(FormIntent::Stash)
        );
    }

    #[test]
    fn test_save_this() {
        assert_eq!(quick_intent_detect("save this"), Some(FormIntent::Stash));
    }

    // ═══ RESTORE ═══

    #[test]
    fn test_resume_keyword() {
        assert_eq!(quick_intent_detect("resume"), Some(FormIntent::Restore));
    }

    #[test]
    fn test_continue_keyword() {
        assert_eq!(quick_intent_detect("continue"), Some(FormIntent::Restore));
    }

    #[test]
    fn test_go_back_to() {
        assert_eq!(
            quick_intent_detect("go back to the form"),
            Some(FormIntent::Restore)
        );
    }

    #[test]
    fn test_get_back_to() {
        assert_eq!(
            quick_intent_detect("get back to it"),
            Some(FormIntent::Restore)
        );
    }

    // ═══ UNDO ═══

    #[test]
    fn test_undo_keyword() {
        assert_eq!(quick_intent_detect("undo"), Some(FormIntent::Undo));
    }

    #[test]
    fn test_go_back_undo() {
        assert_eq!(quick_intent_detect("go back"), Some(FormIntent::Undo));
    }

    #[test]
    fn test_oops_keyword() {
        assert_eq!(quick_intent_detect("oops"), Some(FormIntent::Undo));
    }

    #[test]
    fn test_thats_wrong() {
        assert_eq!(quick_intent_detect("that's wrong"), Some(FormIntent::Undo));
    }

    #[test]
    fn test_wrong_keyword() {
        assert_eq!(quick_intent_detect("wrong"), Some(FormIntent::Undo));
    }

    #[test]
    fn test_not_right() {
        assert_eq!(quick_intent_detect("not right"), Some(FormIntent::Undo));
    }

    // ═══ SKIP ═══

    #[test]
    fn test_skip_keyword() {
        assert_eq!(quick_intent_detect("skip"), Some(FormIntent::Skip));
    }

    #[test]
    fn test_pass_keyword() {
        assert_eq!(quick_intent_detect("pass"), Some(FormIntent::Skip));
    }

    #[test]
    fn test_dont_know() {
        assert_eq!(quick_intent_detect("don't know"), Some(FormIntent::Skip));
    }

    #[test]
    fn test_next_keyword() {
        assert_eq!(quick_intent_detect("next"), Some(FormIntent::Skip));
    }

    #[test]
    fn test_no_idea() {
        assert_eq!(quick_intent_detect("no idea"), Some(FormIntent::Skip));
    }

    // ═══ EXPLAIN ═══

    #[test]
    fn test_why_keyword() {
        assert_eq!(quick_intent_detect("why"), Some(FormIntent::Explain));
    }

    #[test]
    fn test_why_question() {
        assert_eq!(quick_intent_detect("why?"), Some(FormIntent::Explain));
    }

    #[test]
    fn test_explain_keyword() {
        assert_eq!(quick_intent_detect("explain"), Some(FormIntent::Explain));
    }

    #[test]
    fn test_whats_that_for() {
        assert_eq!(
            quick_intent_detect("what's that for?"),
            Some(FormIntent::Explain)
        );
    }

    #[test]
    fn test_what_do_you_mean() {
        assert_eq!(
            quick_intent_detect("what do you mean?"),
            Some(FormIntent::Explain)
        );
    }

    // ═══ EXAMPLE ═══

    #[test]
    fn test_example_keyword() {
        assert_eq!(quick_intent_detect("example"), Some(FormIntent::Example));
    }

    #[test]
    fn test_example_question() {
        assert_eq!(quick_intent_detect("example?"), Some(FormIntent::Example));
    }

    #[test]
    fn test_like_what() {
        assert_eq!(
            quick_intent_detect("like what?"),
            Some(FormIntent::Example)
        );
    }

    #[test]
    fn test_show_me() {
        assert_eq!(quick_intent_detect("show me"), Some(FormIntent::Example));
    }

    #[test]
    fn test_for_instance() {
        assert_eq!(
            quick_intent_detect("for instance?"),
            Some(FormIntent::Example)
        );
    }

    // ═══ PROGRESS ═══

    #[test]
    fn test_how_far() {
        assert_eq!(quick_intent_detect("how far"), Some(FormIntent::Progress));
    }

    #[test]
    fn test_how_many_left() {
        assert_eq!(
            quick_intent_detect("how many left"),
            Some(FormIntent::Progress)
        );
    }

    #[test]
    fn test_progress_keyword() {
        assert_eq!(quick_intent_detect("progress"), Some(FormIntent::Progress));
    }

    #[test]
    fn test_status_keyword() {
        assert_eq!(quick_intent_detect("status"), Some(FormIntent::Progress));
    }

    // ═══ AUTOFILL ═══

    #[test]
    fn test_same_as_last_time() {
        assert_eq!(
            quick_intent_detect("same as last time"),
            Some(FormIntent::Autofill)
        );
    }

    #[test]
    fn test_use_my_usual() {
        assert_eq!(
            quick_intent_detect("use my usual"),
            Some(FormIntent::Autofill)
        );
    }

    #[test]
    fn test_like_before() {
        assert_eq!(
            quick_intent_detect("like before"),
            Some(FormIntent::Autofill)
        );
    }

    #[test]
    fn test_from_before() {
        assert_eq!(
            quick_intent_detect("from before"),
            Some(FormIntent::Autofill)
        );
    }

    // ═══ EXCLUSION PATTERNS ═══

    #[test]
    fn test_save_and_submit_is_not_stash() {
        // "save and submit" should not be stash
        assert_ne!(
            quick_intent_detect("save and submit"),
            Some(FormIntent::Stash)
        );
    }

    #[test]
    fn test_save_and_send_is_not_stash() {
        assert_ne!(
            quick_intent_detect("save and send"),
            Some(FormIntent::Stash)
        );
    }

    #[test]
    fn test_skip_to_is_not_skip() {
        assert_ne!(
            quick_intent_detect("skip to question 5"),
            Some(FormIntent::Skip)
        );
    }

    // ═══ EDGE CASES ═══

    #[test]
    fn test_empty_string() {
        assert_eq!(quick_intent_detect(""), None);
    }

    #[test]
    fn test_single_char() {
        assert_eq!(quick_intent_detect("a"), None);
    }

    #[test]
    fn test_case_insensitivity() {
        assert_eq!(quick_intent_detect("SUBMIT"), Some(FormIntent::Submit));
        assert_eq!(quick_intent_detect("Cancel"), Some(FormIntent::Cancel));
        assert_eq!(quick_intent_detect("UNDO"), Some(FormIntent::Undo));
    }

    #[test]
    fn test_embedded_in_sentence() {
        assert_eq!(
            quick_intent_detect("I want to cancel this"),
            Some(FormIntent::Cancel)
        );
    }

    #[test]
    fn test_no_match_returns_none() {
        assert_eq!(quick_intent_detect("my email is user@example.com"), None);
    }

    #[test]
    fn test_whitespace_trimmed() {
        assert_eq!(quick_intent_detect("  submit  "), Some(FormIntent::Submit));
    }

    // ═══ HELPER FUNCTIONS ═══

    #[test]
    fn test_is_lifecycle_submit() {
        assert!(is_lifecycle_intent(&FormIntent::Submit));
    }

    #[test]
    fn test_is_lifecycle_stash() {
        assert!(is_lifecycle_intent(&FormIntent::Stash));
    }

    #[test]
    fn test_is_lifecycle_restore() {
        assert!(is_lifecycle_intent(&FormIntent::Restore));
    }

    #[test]
    fn test_is_lifecycle_cancel() {
        assert!(is_lifecycle_intent(&FormIntent::Cancel));
    }

    #[test]
    fn test_is_not_lifecycle_undo() {
        assert!(!is_lifecycle_intent(&FormIntent::Undo));
    }

    #[test]
    fn test_is_not_lifecycle_fill() {
        assert!(!is_lifecycle_intent(&FormIntent::FillForm));
    }

    #[test]
    fn test_is_ux_undo() {
        assert!(is_ux_intent(&FormIntent::Undo));
    }

    #[test]
    fn test_is_ux_skip() {
        assert!(is_ux_intent(&FormIntent::Skip));
    }

    #[test]
    fn test_is_ux_explain() {
        assert!(is_ux_intent(&FormIntent::Explain));
    }

    #[test]
    fn test_is_ux_example() {
        assert!(is_ux_intent(&FormIntent::Example));
    }

    #[test]
    fn test_is_ux_progress() {
        assert!(is_ux_intent(&FormIntent::Progress));
    }

    #[test]
    fn test_is_ux_autofill() {
        assert!(is_ux_intent(&FormIntent::Autofill));
    }

    #[test]
    fn test_is_not_ux_submit() {
        assert!(!is_ux_intent(&FormIntent::Submit));
    }

    #[test]
    fn test_has_data_fill_form() {
        assert!(has_data_to_extract(&FormIntent::FillForm));
    }

    #[test]
    fn test_has_data_other() {
        assert!(has_data_to_extract(&FormIntent::Other));
    }

    #[test]
    fn test_no_data_submit() {
        assert!(!has_data_to_extract(&FormIntent::Submit));
    }

    #[test]
    fn test_no_data_undo() {
        assert!(!has_data_to_extract(&FormIntent::Undo));
    }
}
