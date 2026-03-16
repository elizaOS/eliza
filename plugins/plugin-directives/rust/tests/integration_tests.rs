use elizaos_plugin_directives::{
    apply_directives, extract_elevated_directive, extract_exec_directive,
    extract_model_directive, extract_reasoning_directive, extract_status_directive,
    extract_think_directive, extract_verbose_directive, format_directive_state,
    normalize_think_level, normalize_verbose_level, normalize_reasoning_level,
    normalize_elevated_level, normalize_exec, parse_all_directives, strip_directives,
    DirectiveState, ElevatedLevel, ExecConfig, ModelConfig, ReasoningLevel,
    ThinkLevel, VerboseLevel,
};
use pretty_assertions::assert_eq;

// ============================================================================
// Normalizer Tests
// ============================================================================

#[test]
fn test_normalize_think_level() {
    assert_eq!(normalize_think_level("off"), Some(ThinkLevel::Off));
    assert_eq!(normalize_think_level("disabled"), Some(ThinkLevel::Off));
    assert_eq!(normalize_think_level("on"), Some(ThinkLevel::Concise));
    assert_eq!(normalize_think_level("concise"), Some(ThinkLevel::Concise));
    assert_eq!(normalize_think_level("minimal"), Some(ThinkLevel::Concise));
    assert_eq!(normalize_think_level("low"), Some(ThinkLevel::Concise));
    assert_eq!(normalize_think_level("verbose"), Some(ThinkLevel::Verbose));
    assert_eq!(normalize_think_level("high"), Some(ThinkLevel::Verbose));
    assert_eq!(normalize_think_level("ultra"), Some(ThinkLevel::Verbose));
    assert_eq!(normalize_think_level("max"), Some(ThinkLevel::Verbose));
    assert_eq!(normalize_think_level("xhigh"), Some(ThinkLevel::Verbose));
    assert_eq!(normalize_think_level("garbage"), None);
}

#[test]
fn test_normalize_verbose_level() {
    assert_eq!(normalize_verbose_level("off"), Some(VerboseLevel::Off));
    assert_eq!(normalize_verbose_level("false"), Some(VerboseLevel::Off));
    assert_eq!(normalize_verbose_level("on"), Some(VerboseLevel::On));
    assert_eq!(normalize_verbose_level("true"), Some(VerboseLevel::On));
    assert_eq!(normalize_verbose_level("full"), Some(VerboseLevel::On));
    assert_eq!(normalize_verbose_level("nope"), None);
}

#[test]
fn test_normalize_reasoning_level() {
    assert_eq!(normalize_reasoning_level("off"), Some(ReasoningLevel::Off));
    assert_eq!(normalize_reasoning_level("hide"), Some(ReasoningLevel::Off));
    assert_eq!(normalize_reasoning_level("on"), Some(ReasoningLevel::Brief));
    assert_eq!(normalize_reasoning_level("show"), Some(ReasoningLevel::Brief));
    assert_eq!(normalize_reasoning_level("brief"), Some(ReasoningLevel::Brief));
    assert_eq!(normalize_reasoning_level("detailed"), Some(ReasoningLevel::Detailed));
    assert_eq!(normalize_reasoning_level("stream"), Some(ReasoningLevel::Detailed));
    assert_eq!(normalize_reasoning_level("live"), Some(ReasoningLevel::Detailed));
    assert_eq!(normalize_reasoning_level("xyz"), None);
}

#[test]
fn test_normalize_elevated_level() {
    assert_eq!(normalize_elevated_level("off"), Some(ElevatedLevel::Off));
    assert_eq!(normalize_elevated_level("false"), Some(ElevatedLevel::Off));
    assert_eq!(normalize_elevated_level("on"), Some(ElevatedLevel::On));
    assert_eq!(normalize_elevated_level("true"), Some(ElevatedLevel::On));
    assert_eq!(normalize_elevated_level("full"), Some(ElevatedLevel::On));
    assert_eq!(normalize_elevated_level("ask"), Some(ElevatedLevel::On));
    assert_eq!(normalize_elevated_level("bad"), None);
}

#[test]
fn test_normalize_exec() {
    assert_eq!(normalize_exec("off"), Some(ExecConfig { enabled: false, auto_approve: false }));
    assert_eq!(normalize_exec("on"), Some(ExecConfig { enabled: true, auto_approve: false }));
    assert_eq!(normalize_exec("auto-approve"), Some(ExecConfig { enabled: true, auto_approve: true }));
    assert_eq!(normalize_exec("approve"), Some(ExecConfig { enabled: true, auto_approve: true }));
    assert_eq!(normalize_exec("whatever"), None);
}

// ============================================================================
// Individual Extractor Tests
// ============================================================================

#[test]
fn test_extract_think_high() {
    let result = extract_think_directive("/think:high hello");
    assert_eq!(result, Some(ThinkLevel::Verbose));
}

#[test]
fn test_extract_think_concise() {
    let result = extract_think_directive("/think:concise explain this");
    assert_eq!(result, Some(ThinkLevel::Concise));
}

#[test]
fn test_extract_think_off() {
    let result = extract_think_directive("/t off quick reply");
    assert_eq!(result, Some(ThinkLevel::Off));
}

#[test]
fn test_extract_think_shorthand() {
    let result = extract_think_directive("/t medium world");
    assert_eq!(result, Some(ThinkLevel::Verbose));
}

#[test]
fn test_extract_think_missing() {
    let result = extract_think_directive("hello world no directives");
    assert_eq!(result, None);
}

#[test]
fn test_extract_verbose_on() {
    let result = extract_verbose_directive("/verbose:on test");
    assert_eq!(result, Some(VerboseLevel::On));
}

#[test]
fn test_extract_verbose_shorthand() {
    let result = extract_verbose_directive("/v on message");
    assert_eq!(result, Some(VerboseLevel::On));
}

#[test]
fn test_extract_reasoning_brief() {
    let result = extract_reasoning_directive("/reasoning:on test");
    assert_eq!(result, Some(ReasoningLevel::Brief));
}

#[test]
fn test_extract_reasoning_detailed() {
    let result = extract_reasoning_directive("/reason:stream show me");
    assert_eq!(result, Some(ReasoningLevel::Detailed));
}

#[test]
fn test_extract_elevated_on() {
    let result = extract_elevated_directive("/elevated:on do it");
    assert_eq!(result, Some(ElevatedLevel::On));
}

#[test]
fn test_extract_elevated_off() {
    let result = extract_elevated_directive("/elev off stop");
    assert_eq!(result, Some(ElevatedLevel::Off));
}

#[test]
fn test_extract_exec_bare() {
    let result = extract_exec_directive("/exec do something");
    assert_eq!(
        result,
        Some(ExecConfig {
            enabled: true,
            auto_approve: false,
        })
    );
}

#[test]
fn test_extract_exec_auto_approve() {
    let result = extract_exec_directive("/exec auto-approve");
    assert_eq!(
        result,
        Some(ExecConfig {
            enabled: true,
            auto_approve: true,
        })
    );
}

#[test]
fn test_extract_model_with_provider() {
    let result = extract_model_directive("/model anthropic/claude-3-opus test");
    assert_eq!(
        result,
        Some(ModelConfig {
            provider: Some("anthropic".to_string()),
            model: Some("claude-3-opus".to_string()),
            temperature: None,
        })
    );
}

#[test]
fn test_extract_model_without_provider() {
    let result = extract_model_directive("/model gpt-4o hello");
    assert_eq!(
        result,
        Some(ModelConfig {
            provider: None,
            model: Some("gpt-4o".to_string()),
            temperature: None,
        })
    );
}

#[test]
fn test_extract_status() {
    assert!(extract_status_directive("/status hello"));
    assert!(!extract_status_directive("hello no status"));
}

// ============================================================================
// parse_all_directives Tests
// ============================================================================

#[test]
fn test_parse_all_single_directive() {
    let result = parse_all_directives("/think:high hello world");
    assert!(result.has_think);
    assert_eq!(result.think, Some(ThinkLevel::Verbose));
    assert_eq!(result.cleaned_text, "hello world");
    assert!(!result.directives_only);
}

#[test]
fn test_parse_all_multiple_directives() {
    let result = parse_all_directives("/think:concise /v on /elevated on hello");
    assert!(result.has_think);
    assert_eq!(result.think, Some(ThinkLevel::Concise));
    assert!(result.has_verbose);
    assert_eq!(result.verbose, Some(VerboseLevel::On));
    assert!(result.has_elevated);
    assert_eq!(result.elevated, Some(ElevatedLevel::On));
    assert_eq!(result.cleaned_text, "hello");
    assert!(!result.directives_only);
}

#[test]
fn test_parse_all_directives_only() {
    let result = parse_all_directives("/think:high /verbose on");
    assert!(result.directives_only);
    assert!(result.cleaned_text.is_empty());
}

#[test]
fn test_parse_all_no_directives() {
    let result = parse_all_directives("just a normal message");
    assert!(!result.has_think);
    assert!(!result.has_verbose);
    assert!(!result.has_reasoning);
    assert!(!result.has_elevated);
    assert!(!result.has_exec);
    assert!(!result.has_model);
    assert!(!result.has_status);
    assert!(!result.directives_only);
    assert_eq!(result.cleaned_text, "just a normal message");
}

#[test]
fn test_parse_all_with_model() {
    let result = parse_all_directives("/model openai/gpt-4o what is 2+2");
    assert!(result.has_model);
    let model = result.model.unwrap();
    assert_eq!(model.provider, Some("openai".to_string()));
    assert_eq!(model.model, Some("gpt-4o".to_string()));
    assert_eq!(result.cleaned_text, "what is 2+2");
}

#[test]
fn test_parse_all_with_status() {
    let result = parse_all_directives("/status check in");
    assert!(result.has_status);
}

// ============================================================================
// strip_directives Tests
// ============================================================================

#[test]
fn test_strip_removes_all_markers() {
    let cleaned = strip_directives("/think:high /verbose on hello world");
    assert_eq!(cleaned, "hello world");
}

#[test]
fn test_strip_preserves_text_without_directives() {
    let cleaned = strip_directives("nothing special here");
    assert_eq!(cleaned, "nothing special here");
}

// ============================================================================
// Edge Cases
// ============================================================================

#[test]
fn test_empty_text() {
    let result = parse_all_directives("");
    assert!(!result.has_think);
    assert!(result.cleaned_text.is_empty());
    assert!(!result.directives_only);
}

#[test]
fn test_invalid_directive_value() {
    // /think:banana — "banana" doesn't normalize to any ThinkLevel
    let result = parse_all_directives("/think:banana hello");
    assert!(result.has_think);
    assert_eq!(result.think, None); // invalid value → None
}

#[test]
fn test_directive_not_matched_inside_word() {
    // /thinking is a valid directive name; /thinkpad is not
    let result = parse_all_directives("check /thinkpad specs");
    assert!(!result.has_think);
    assert_eq!(result.cleaned_text, "check /thinkpad specs");
}

// ============================================================================
// DirectiveState Tests
// ============================================================================

#[test]
fn test_directive_state_serialization() {
    let state = DirectiveState {
        thinking: ThinkLevel::Verbose,
        verbose: VerboseLevel::On,
        reasoning: ReasoningLevel::Brief,
        elevated: ElevatedLevel::Off,
        exec: ExecConfig {
            enabled: true,
            auto_approve: false,
        },
        model: ModelConfig {
            provider: Some("anthropic".to_string()),
            model: Some("claude-3".to_string()),
            temperature: Some(0.7),
        },
    };

    let json = serde_json::to_value(&state).unwrap();
    assert_eq!(json["thinking"], "verbose");
    assert_eq!(json["verbose"], "on");
    assert_eq!(json["reasoning"], "brief");
    assert_eq!(json["elevated"], "off");
    assert_eq!(json["exec"]["enabled"], true);
    assert_eq!(json["model"]["provider"], "anthropic");
    assert_eq!(json["model"]["temperature"], 0.7);

    // round-trip
    let deser: DirectiveState = serde_json::from_value(json).unwrap();
    assert_eq!(deser, state);
}

#[test]
fn test_directive_state_default() {
    let state = DirectiveState::default();
    assert_eq!(state.thinking, ThinkLevel::Off);
    assert_eq!(state.verbose, VerboseLevel::Off);
    assert_eq!(state.reasoning, ReasoningLevel::Off);
    assert_eq!(state.elevated, ElevatedLevel::Off);
    assert!(!state.exec.enabled);
    assert!(state.model.provider.is_none());
}

#[test]
fn test_apply_directives() {
    let base = DirectiveState::default();
    let directives = parse_all_directives("/think:high /verbose on");
    let updated = apply_directives(&base, &directives);

    assert_eq!(updated.thinking, ThinkLevel::Verbose);
    assert_eq!(updated.verbose, VerboseLevel::On);
    // unchanged fields
    assert_eq!(updated.reasoning, ReasoningLevel::Off);
    assert_eq!(updated.elevated, ElevatedLevel::Off);
}

#[test]
fn test_apply_preserves_existing_state() {
    let mut state = DirectiveState::default();
    state.thinking = ThinkLevel::Verbose;

    let directives = parse_all_directives("/verbose on");
    let updated = apply_directives(&state, &directives);

    assert_eq!(updated.thinking, ThinkLevel::Verbose); // preserved
    assert_eq!(updated.verbose, VerboseLevel::On); // updated
}

#[test]
fn test_format_directive_state() {
    let state = DirectiveState {
        thinking: ThinkLevel::Concise,
        verbose: VerboseLevel::On,
        reasoning: ReasoningLevel::Off,
        elevated: ElevatedLevel::Off,
        exec: ExecConfig::default(),
        model: ModelConfig {
            provider: Some("openai".to_string()),
            model: Some("gpt-4o".to_string()),
            temperature: None,
        },
    };
    let text = format_directive_state(&state);
    assert!(text.contains("Thinking: concise"));
    assert!(text.contains("Verbose: on"));
    assert!(text.contains("Model: openai/gpt-4o"));
}

#[test]
fn test_case_insensitive_directives() {
    let result = parse_all_directives("/THINK:HIGH /Verbose ON hello");
    assert!(result.has_think);
    assert_eq!(result.think, Some(ThinkLevel::Verbose));
    assert!(result.has_verbose);
    assert_eq!(result.verbose, Some(VerboseLevel::On));
}

#[test]
fn test_colon_separated_and_space_separated() {
    let colon = extract_think_directive("/think:high test");
    let space = extract_think_directive("/think high test");
    assert_eq!(colon, space);
    assert_eq!(colon, Some(ThinkLevel::Verbose));
}
