from elizaos_plugin_experience.prompts import build_extract_experiences_prompt


def test_build_extract_experiences_prompt_replaces_placeholders() -> None:
    prompt = build_extract_experiences_prompt(
        conversation_context="hello world",
        existing_experiences="- example",
    )

    assert "hello world" in prompt
    assert "- example" in prompt
    assert "{{conversation_context}}" not in prompt
    assert "{{existing_experiences}}" not in prompt
