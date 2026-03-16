//! Auto-generated canonical action/provider/evaluator docs for plugin-farcaster.
//! DO NOT EDIT - Generated from prompts/specs/**.

pub const CORE_ACTION_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "actions": [
    {
      "name": "SEND_CAST",
      "description": "Posts a cast (message) on Farcaster",
      "similes": [
        "POST_CAST",
        "FARCASTER_POST",
        "CAST",
        "SHARE_ON_FARCASTER",
        "ANNOUNCE"
      ],
      "parameters": []
    },
    {
      "name": "REPLY_TO_CAST",
      "description": "Replies to a cast on Farcaster",
      "similes": [
        "REPLY_CAST",
        "RESPOND_CAST",
        "ANSWER_CAST",
        "COMMENT_CAST"
      ],
      "parameters": []
    }
  ]
}"#;
pub const ALL_ACTION_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "actions": [
    {
      "name": "SEND_CAST",
      "description": "Posts a cast (message) on Farcaster",
      "similes": [
        "POST_CAST",
        "FARCASTER_POST",
        "CAST",
        "SHARE_ON_FARCASTER",
        "ANNOUNCE"
      ],
      "parameters": []
    },
    {
      "name": "REPLY_TO_CAST",
      "description": "Replies to a cast on Farcaster",
      "similes": [
        "REPLY_CAST",
        "RESPOND_CAST",
        "ANSWER_CAST",
        "COMMENT_CAST"
      ],
      "parameters": []
    }
  ]
}"#;
pub const CORE_PROVIDER_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "providers": [
    {
      "name": "farcasterProfile",
      "description": "Provides information about the agent",
      "dynamic": true
    },
    {
      "name": "farcasterThread",
      "description": "Provides thread context for Farcaster casts so the agent can reference the full conversation.",
      "dynamic": true
    },
    {
      "name": "farcasterTimeline",
      "description": "Provides recent casts from the agent",
      "dynamic": true
    }
  ]
}"#;
pub const ALL_PROVIDER_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "providers": [
    {
      "name": "farcasterProfile",
      "description": "Provides information about the agent",
      "dynamic": true
    },
    {
      "name": "farcasterThread",
      "description": "Provides thread context for Farcaster casts so the agent can reference the full conversation.",
      "dynamic": true
    },
    {
      "name": "farcasterTimeline",
      "description": "Provides recent casts from the agent",
      "dynamic": true
    }
  ]
}"#;
pub const CORE_EVALUATOR_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "evaluators": []
}"#;
pub const ALL_EVALUATOR_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "evaluators": []
}"#;
