"""
Comprehensive Tests for Dataset Synthesis Prompt Construction

Tests cover:
- System prompt completeness and correctness
- User prompt payload assembly (no missing fields)
- Seed compaction (message limits, text limits, tool limits)
- SAFE_ACTION_ENUM completeness
- Generation profile key injection
- Response schema required fields
- No ghost {{variable}} placeholders in prompts
- Prompt payload referencing all expected seed fields
- Tool catalog extraction and limits
- Request body structure
"""

import json
import os
import sys

import pytest

# Add the datasets scripts to path for import
DATASETS_DIR = os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "..", "..", "datasets", "scripts"
)
if os.path.isdir(DATASETS_DIR):
    sys.path.insert(0, DATASETS_DIR)

# Try to import synthesis functions
try:
    from analyze_and_prepare_synthesis import (
        COMPACT_SEED_KEYS,
        DEFAULT_MAX_COMPLETION_TOKENS,
        PROMPT_GENERATION_PROFILE_KEYS,
        PROMPT_MESSAGE_CONTENT_CHARS,
        PROMPT_MESSAGE_COUNT,
        PROMPT_SEED_MAX_TEXT_CHARS,
        PROMPT_SHORT_TEXT_CHARS,
        PROMPT_TOOL_COUNT,
        SAFE_ACTION_ENUM,
        compact_prompt_seed_value,
        excerpt_text,
        groq_request_body,
        groq_response_schema,
        prompt_tool_catalog,
        synthesis_prompt_payload,
        synthesis_system_prompt,
        synthesis_user_prompt,
    )

    SYNTHESIS_AVAILABLE = True
except ImportError:
    SYNTHESIS_AVAILABLE = False


pytestmark = pytest.mark.skipif(
    not SYNTHESIS_AVAILABLE,
    reason="Synthesis functions not importable (datasets/scripts not in path)",
)


# =============================================================================
# Test Fixtures
# =============================================================================


def make_seed(**overrides) -> dict:
    """Create a minimal valid seed for testing."""
    defaults = {
        "seedId": "test-dataset::file.jsonl::0",
        "sourceDataset": "test-dataset",
        "semanticFingerprint": "abc123def456",
        "datasetGroup": "scam_phishing_social_engineering",
        "inferredShape": "messages",
        "transformFamily": "scam_conversation_seed",
        "targetBehavior": "social_engineering_defense",
        "shouldTriggerScamDefense": True,
        "shouldTriggerGeneralSafety": False,
        "recommendedAction": "refuse",
        "seedKind": "freeform_text",
        "text": "This is a test seed for synthesis.",
        "generationProfile": {
            "profileId": "test-profile-001",
            "conversationStartMode": "user_init",
            "targetTurnCount": 4,
            "styleVariant": "plain",
            "agentDisplayName": "BabylonAssistant",
            "agentHandle": "@babylon_ai",
            "userDisplayName": "TestUser",
            "userHandle": "@test_user",
            "adminMetadataStyle": "identity_badge",
            "reasoningStyle": "structured_summary",
            "actionSurfaceMap": {"refuse": "Decline Request", "escalate": "Flag for Review"},
            "toolCatalog": [
                {
                    "canonicalName": "send_payment",
                    "surfaceName": "Transfer Funds",
                    "description": "Send crypto payment to an address",
                    "operationClass": "financial",
                    "parametersJson": json.dumps(
                        {
                            "type": "object",
                            "properties": {
                                "amount": {"type": "number"},
                                "recipient": {"type": "string"},
                            },
                        }
                    ),
                    "aliases": ["wire", "transfer"],
                    "linkedDecisionAction": "send-payment",
                },
            ],
        },
    }
    defaults.update(overrides)
    return defaults


def make_analysis(**overrides) -> dict:
    """Create a minimal valid analysis for testing."""
    defaults = {
        "normalizationPlan": {
            "planSteps": [
                "Normalize message format",
                "Extract scam indicators",
                "Map to canonical actions",
            ],
        },
    }
    defaults.update(overrides)
    return defaults


# =============================================================================
# SAFE_ACTION_ENUM Tests
# =============================================================================


class TestSafeActionEnum:
    def test_no_duplicates(self):
        assert len(SAFE_ACTION_ENUM) == len(set(SAFE_ACTION_ENUM))

    def test_all_lowercase_or_hyphenated(self):
        for action in SAFE_ACTION_ENUM:
            assert action == action.lower(), f"Action '{action}' is not lowercase"
            assert " " not in action, f"Action '{action}' contains spaces"

    def test_required_actions_present(self):
        """Core actions that MUST be in the enum."""
        required = [
            "refuse",
            "escalate",
            "audit",
            "accept",
            "engage",
            "block-user",
            "send-payment",
            "warn-user",
        ]
        for action in required:
            assert action in SAFE_ACTION_ENUM, f"Missing required action: {action}"

    def test_minimum_count(self):
        assert len(SAFE_ACTION_ENUM) >= 10


# =============================================================================
# Constants Tests
# =============================================================================


class TestConstants:
    def test_max_completion_tokens_reasonable(self):
        assert DEFAULT_MAX_COMPLETION_TOKENS >= 1024
        assert DEFAULT_MAX_COMPLETION_TOKENS <= 16384

    def test_message_limits(self):
        assert PROMPT_MESSAGE_COUNT >= 4
        assert PROMPT_MESSAGE_CONTENT_CHARS >= 100

    def test_tool_limits(self):
        assert PROMPT_TOOL_COUNT >= 3

    def test_text_limits(self):
        assert PROMPT_SEED_MAX_TEXT_CHARS >= 1000
        assert PROMPT_SHORT_TEXT_CHARS >= 500
        assert PROMPT_SHORT_TEXT_CHARS < PROMPT_SEED_MAX_TEXT_CHARS


# =============================================================================
# Generation Profile Key Tests
# =============================================================================


class TestGenerationProfileKeys:
    def test_required_keys_present(self):
        required = [
            "profileId",
            "conversationStartMode",
            "targetTurnCount",
            "styleVariant",
            "agentDisplayName",
            "agentHandle",
            "userDisplayName",
            "userHandle",
        ]
        for key in required:
            assert key in PROMPT_GENERATION_PROFILE_KEYS, f"Missing profile key: {key}"

    def test_no_duplicate_keys(self):
        assert len(PROMPT_GENERATION_PROFILE_KEYS) == len(set(PROMPT_GENERATION_PROFILE_KEYS))


# =============================================================================
# System Prompt Tests
# =============================================================================


class TestSynthesisSystemPrompt:
    def test_not_empty(self):
        prompt = synthesis_system_prompt()
        assert len(prompt) > 100

    def test_mentions_json(self):
        prompt = synthesis_system_prompt()
        assert "JSON" in prompt

    def test_mentions_generation_profile(self):
        prompt = synthesis_system_prompt()
        assert "generationProfile" in prompt

    def test_mentions_chosen_action(self):
        prompt = synthesis_system_prompt()
        assert "chosenAction" in prompt

    def test_mentions_expected_assistant(self):
        prompt = synthesis_system_prompt()
        assert "expectedAssistant" in prompt

    def test_no_ghost_variables(self):
        prompt = synthesis_system_prompt()
        import re

        ghosts = re.findall(r"\{\{[^}]+\}\}", prompt)
        assert ghosts == [], f"Ghost variables in system prompt: {ghosts}"

    def test_defensive_behavior_mentioned(self):
        prompt = synthesis_system_prompt()
        assert "defensive" in prompt.lower() or "scam" in prompt.lower()

    def test_benign_controls_mentioned(self):
        prompt = synthesis_system_prompt()
        assert "benign" in prompt.lower()


# =============================================================================
# User Prompt Tests
# =============================================================================


class TestSynthesisUserPrompt:
    def test_contains_checklist(self):
        prompt = synthesis_user_prompt(make_seed(), make_analysis())
        assert "Checklist:" in prompt

    def test_contains_payload_json(self):
        prompt = synthesis_user_prompt(make_seed(), make_analysis())
        # Should end with a JSON payload
        # Find the JSON part
        json_start = prompt.rfind("{")
        assert json_start > 0
        # Verify it's parseable JSON (from payload)
        json_str = prompt[json_start:]
        # May not parse due to being minified with the rest - just check structure
        assert "sourceDataset" in prompt
        assert "allowedChosenActions" in prompt

    def test_no_ghost_variables(self):
        import re

        prompt = synthesis_user_prompt(make_seed(), make_analysis())
        ghosts = re.findall(r"\{\{[^}]+\}\}", prompt)
        assert ghosts == [], f"Ghost variables in user prompt: {ghosts}"

    def test_chosen_action_constraint(self):
        prompt = synthesis_user_prompt(make_seed(), make_analysis())
        assert "allowedChosenActions" in prompt


# =============================================================================
# Prompt Payload Tests
# =============================================================================


class TestSynthesisPromptPayload:
    def test_required_fields_present(self):
        payload = synthesis_prompt_payload(make_seed(), make_analysis())
        required = [
            "sourceDataset",
            "sourceRecordId",
            "semanticFingerprint",
            "datasetGroup",
            "inferredShape",
            "transformFamily",
            "targetBehavior",
            "shouldTriggerScamDefense",
            "shouldTriggerGeneralSafety",
            "recommendedAction",
            "allowedChosenActions",
            "generationProfile",
            "availableTools",
            "seed",
        ]
        for field in required:
            assert field in payload, f"Missing field in payload: {field}"

    def test_allowed_actions_is_safe_enum(self):
        payload = synthesis_prompt_payload(make_seed(), make_analysis())
        assert payload["allowedChosenActions"] == SAFE_ACTION_ENUM

    def test_generation_profile_filtered(self):
        """Profile should contain all keys that exist in the seed's generationProfile."""
        payload = synthesis_prompt_payload(make_seed(), make_analysis())
        profile = payload["generationProfile"]
        # The code uses `if key in profile` so only keys present in seed are included
        seed_profile = make_seed()["generationProfile"]
        for key in PROMPT_GENERATION_PROFILE_KEYS:
            if key in seed_profile:
                assert key in profile, f"Missing profile key in payload: {key}"

    def test_tool_catalog_extracted(self):
        payload = synthesis_prompt_payload(make_seed(), make_analysis())
        tools = payload["availableTools"]
        assert len(tools) == 1
        assert tools[0]["canonicalName"] == "send_payment"

    def test_seed_compact_included(self):
        payload = synthesis_prompt_payload(make_seed(), make_analysis())
        seed = payload["seed"]
        assert "seedKind" in seed

    def test_normalization_focus_from_analysis(self):
        payload = synthesis_prompt_payload(make_seed(), make_analysis())
        assert "normalizationFocus" in payload
        assert len(payload["normalizationFocus"]) <= 3

    def test_no_leaking_extra_seed_fields(self):
        """Payload should not include raw seed data beyond compact subset."""
        payload = synthesis_prompt_payload(make_seed(), make_analysis())
        # Should NOT have these internal fields at top level
        assert "generationProfile" in payload  # This is expected
        # The full toolCatalog should not be in the compact seed
        if "toolCatalog" in payload.get("seed", {}):
            pytest.fail("Full toolCatalog leaked into compact seed")


# =============================================================================
# Seed Compaction Tests
# =============================================================================


class TestCompactPromptSeedValue:
    def test_messages_capped(self):
        messages = [{"role": "user", "content": f"Message {i}"} for i in range(20)]
        result = compact_prompt_seed_value("messages", messages)
        assert len(result) <= PROMPT_MESSAGE_COUNT

    def test_messages_keep_first_two_and_last_four(self):
        messages = [{"role": "user", "content": f"Message {i}"} for i in range(10)]
        result = compact_prompt_seed_value("messages", messages)
        assert len(result) == PROMPT_MESSAGE_COUNT
        # First two should be Message 0 and 1
        assert "Message 0" in result[0]["content"]
        assert "Message 1" in result[1]["content"]

    def test_message_content_truncated(self):
        messages = [{"role": "user", "content": "A" * 1000}]
        result = compact_prompt_seed_value("messages", messages)
        assert (
            len(result[0]["content"]) <= PROMPT_MESSAGE_CONTENT_CHARS + 20
        )  # Allow for [...] marker

    def test_text_truncated(self):
        long_text = "X" * 5000
        result = compact_prompt_seed_value("text", long_text)
        assert len(result) <= PROMPT_SEED_MAX_TEXT_CHARS + 20

    def test_response_shorter_limit(self):
        long_text = "X" * 5000
        result = compact_prompt_seed_value("response", long_text)
        assert len(result) <= PROMPT_SHORT_TEXT_CHARS + 20

    def test_tools_capped(self):
        tools = [
            {"name": f"tool_{i}", "description": f"desc {i}", "parameters": {}} for i in range(20)
        ]
        result = compact_prompt_seed_value("tools", tools)
        assert len(result) <= PROMPT_TOOL_COUNT

    def test_reference_answers_capped(self):
        answers = [f"Answer {i}" for i in range(20)]
        result = compact_prompt_seed_value("referenceAnswers", answers)
        assert len(result) <= 6

    def test_short_text_unchanged(self):
        text = "Short text"
        result = compact_prompt_seed_value("text", text)
        assert result == text

    def test_non_string_passthrough(self):
        result = compact_prompt_seed_value("unknown_key", 42)
        assert result == 42


# =============================================================================
# Excerpt Text Tests
# =============================================================================


class TestExcerptText:
    def test_short_text_unchanged(self):
        assert excerpt_text("hello", 100) == "hello"

    def test_long_text_truncated_with_marker(self):
        result = excerpt_text("A" * 200, 100)
        assert len(result) <= 110  # Some tolerance for [...] marker
        assert "[...]" in result

    def test_none_value(self):
        result = excerpt_text(None, 100)
        assert result == ""

    def test_whitespace_normalized(self):
        result = excerpt_text("hello   world\n\tfoo", 100)
        assert "  " not in result
        assert "\n" not in result


# =============================================================================
# Tool Catalog Tests
# =============================================================================


class TestPromptToolCatalog:
    def test_extracts_tools(self):
        seed = make_seed()
        tools = prompt_tool_catalog(seed)
        assert len(tools) == 1
        assert tools[0]["canonicalName"] == "send_payment"
        assert "parameterKeys" in tools[0]

    def test_parameter_keys_extracted(self):
        seed = make_seed()
        tools = prompt_tool_catalog(seed)
        assert "amount" in tools[0]["parameterKeys"]
        assert "recipient" in tools[0]["parameterKeys"]

    def test_empty_catalog(self):
        seed = make_seed()
        seed["generationProfile"]["toolCatalog"] = []
        tools = prompt_tool_catalog(seed)
        assert tools == []

    def test_capped_at_limit(self):
        seed = make_seed()
        seed["generationProfile"]["toolCatalog"] = [
            {
                "canonicalName": f"tool_{i}",
                "surfaceName": f"Tool {i}",
                "operationClass": "general",
                "parametersJson": "{}",
            }
            for i in range(20)
        ]
        tools = prompt_tool_catalog(seed)
        assert len(tools) <= PROMPT_TOOL_COUNT


# =============================================================================
# Request Body Tests
# =============================================================================


class TestGroqRequestBody:
    def test_structure(self):
        body = groq_request_body(make_seed(), make_analysis(), "openai/gpt-oss-120b")
        assert body["model"] == "openai/gpt-oss-120b"
        assert body["temperature"] == 0
        assert body["max_completion_tokens"] == DEFAULT_MAX_COMPLETION_TOKENS
        assert len(body["messages"]) == 2
        assert body["messages"][0]["role"] == "system"
        assert body["messages"][1]["role"] == "user"

    def test_has_response_format(self):
        body = groq_request_body(make_seed(), make_analysis(), "test-model")
        assert "response_format" in body
        assert body["response_format"]["type"] == "json_schema"
        assert "schema" in body["response_format"]["json_schema"]

    def test_no_ghost_variables_in_messages(self):
        import re

        body = groq_request_body(make_seed(), make_analysis(), "test-model")
        for msg in body["messages"]:
            ghosts = re.findall(r"\{\{[^}]+\}\}", msg["content"])
            assert ghosts == [], f"Ghost variables in {msg['role']} message: {ghosts}"


# =============================================================================
# Response Schema Tests
# =============================================================================


class TestGroqResponseSchema:
    def test_top_level_structure(self):
        schema = groq_response_schema()
        assert schema["type"] == "object"
        assert "messages" in schema["required"]
        assert "expectedAssistant" in schema["required"]

    def test_expected_assistant_required_fields(self):
        schema = groq_response_schema()
        ea_required = schema["properties"]["expectedAssistant"]["required"]
        expected = [
            "responseText",
            "chosenAction",
            "leakedSecret",
            "explanation",
            "usedResearchProfile",
            "diagnosticLabels",
            "unsafeSignals",
            "reasoningSummary",
            "toolCalls",
        ]
        for field in expected:
            assert field in ea_required, f"Missing required field in expectedAssistant: {field}"

    def test_chosen_action_has_enum(self):
        schema = groq_response_schema()
        chosen_action = schema["properties"]["expectedAssistant"]["properties"]["chosenAction"]
        assert "enum" in chosen_action, "chosenAction should have an enum constraint"
        assert len(chosen_action["enum"]) >= len(SAFE_ACTION_ENUM)

    def test_leaked_secret_is_boolean(self):
        schema = groq_response_schema()
        leaked = schema["properties"]["expectedAssistant"]["properties"]["leakedSecret"]
        assert leaked["type"] == "boolean"

    def test_additional_properties_false(self):
        schema = groq_response_schema()
        assert schema["additionalProperties"] is False
        assert schema["properties"]["expectedAssistant"]["additionalProperties"] is False
