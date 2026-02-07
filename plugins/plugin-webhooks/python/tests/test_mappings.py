"""Tests for elizaos_plugin_webhooks.mappings – mirrors TS mappings.test.ts."""

from elizaos_plugin_webhooks.mappings import (
    apply_mapping,
    find_mapping,
    render_template,
)
from elizaos_plugin_webhooks.types import HookMapping, HookMatch


class TestRenderTemplate:
    def test_replaces_simple_placeholders(self) -> None:
        result = render_template("Hello {{name}}!", {"name": "World"})
        assert result == "Hello World!"

    def test_replaces_nested_placeholders(self) -> None:
        result = render_template(
            "From: {{sender.name}}", {"sender": {"name": "Alice"}}
        )
        assert result == "From: Alice"

    def test_replaces_array_index_placeholders(self) -> None:
        result = render_template(
            "First: {{items[0].label}}",
            {"items": [{"label": "Apple"}, {"label": "Banana"}]},
        )
        assert result == "First: Apple"

    def test_leaves_unresolved_placeholders_as_is(self) -> None:
        result = render_template("Hi {{unknown}}", {})
        assert result == "Hi {{unknown}}"

    def test_handles_multiple_placeholders(self) -> None:
        result = render_template("{{a}} and {{b}}", {"a": "1", "b": "2"})
        assert result == "1 and 2"

    def test_stringifies_objects(self) -> None:
        result = render_template("Data: {{obj}}", {"obj": {"x": 1}})
        assert result == 'Data: {"x":1}'

    def test_stringifies_lists(self) -> None:
        result = render_template("Arr: {{arr}}", {"arr": [1, 2, 3]})
        assert result == "Arr: [1,2,3]"

    def test_handles_numeric_values(self) -> None:
        result = render_template("Count: {{n}}", {"n": 42})
        assert result == "Count: 42"

    def test_handles_boolean_values(self) -> None:
        result = render_template("Flag: {{flag}}", {"flag": True})
        assert result == "Flag: True"

    def test_deeply_nested_path(self) -> None:
        data = {"a": {"b": {"c": {"d": "deep"}}}}
        result = render_template("{{a.b.c.d}}", data)
        assert result == "deep"

    def test_multiple_array_indices(self) -> None:
        data = {"matrix": [[1, 2], [3, 4]]}
        result = render_template("{{matrix[1][0]}}", data)
        assert result == "3"

    def test_null_value_leaves_placeholder(self) -> None:
        result = render_template("Val: {{key}}", {"key": None})
        assert result == "Val: {{key}}"


class TestFindMapping:
    mappings = [
        HookMapping(
            match=HookMatch(path="gmail"), action="agent", name="Gmail"
        ),
        HookMapping(
            match=HookMatch(path="github"), action="wake", name="GitHub"
        ),
        HookMapping(
            match=HookMatch(source="stripe"), action="agent", name="Stripe"
        ),
    ]

    def test_finds_by_path(self) -> None:
        found = find_mapping(self.mappings, "gmail", {})
        assert found is not None
        assert found.name == "Gmail"

    def test_finds_by_source_in_payload(self) -> None:
        found = find_mapping(
            self.mappings, "whatever", {"source": "stripe"}
        )
        assert found is not None
        assert found.name == "Stripe"

    def test_returns_none_when_no_match(self) -> None:
        found = find_mapping(self.mappings, "unknown", {})
        assert found is None

    def test_returns_first_match(self) -> None:
        mappings = [
            HookMapping(
                match=HookMatch(path="dup"), name="First"
            ),
            HookMapping(
                match=HookMatch(path="dup"), name="Second"
            ),
        ]
        found = find_mapping(mappings, "dup", {})
        assert found is not None
        assert found.name == "First"


class TestApplyMapping:
    def test_applies_wake_mapping(self) -> None:
        mapping = HookMapping(
            action="wake",
            text_template="New event: {{type}}",
            wake_mode="now",
        )
        result = apply_mapping(mapping, "test", {"type": "push"})
        assert result.action == "wake"
        assert result.text == "New event: push"
        assert result.wake_mode == "now"

    def test_applies_agent_mapping_with_template(self) -> None:
        mapping = HookMapping(
            action="agent",
            name="Gmail",
            message_template="Email from {{from}}: {{subject}}",
            session_key="hook:gmail:{{id}}",
            deliver=True,
            channel="discord",
            to="channel:123",
        )
        payload = {"from": "Alice", "subject": "Hi", "id": "msg-42"}
        result = apply_mapping(mapping, "gmail", payload)
        assert result.action == "agent"
        assert result.message == "Email from Alice: Hi"
        assert result.session_key == "hook:gmail:msg-42"
        assert result.deliver is True
        assert result.channel == "discord"
        assert result.to == "channel:123"

    def test_defaults_to_agent_action(self) -> None:
        mapping = HookMapping()
        result = apply_mapping(mapping, "test", {"message": "hello"})
        assert result.action == "agent"
        assert result.message == "hello"

    def test_uses_payload_text_for_wake_when_no_template(self) -> None:
        mapping = HookMapping(action="wake")
        result = apply_mapping(mapping, "test", {"text": "direct text"})
        assert result.text == "direct text"

    def test_defaults_wake_mode_to_now(self) -> None:
        mapping = HookMapping(action="wake")
        result = apply_mapping(mapping, "test", {"text": "t"})
        assert result.wake_mode == "now"

    def test_fallback_text_for_wake_without_template_or_payload(self) -> None:
        mapping = HookMapping(action="wake")
        result = apply_mapping(mapping, "mytest", {})
        assert result.text == "Webhook received: mytest"

    def test_fallback_message_for_agent_without_template_or_payload(self) -> None:
        mapping = HookMapping(action="agent")
        result = apply_mapping(mapping, "mytest", {})
        assert result.message == "Webhook payload from mytest"

    def test_agent_defaults(self) -> None:
        mapping = HookMapping(action="agent", name="Test")
        result = apply_mapping(mapping, "test", {"message": "hi"})
        assert result.deliver is True
        assert result.channel == "last"
        assert result.to is None
        assert result.model is None

    def test_wake_uses_message_template_as_text_fallback(self) -> None:
        mapping = HookMapping(
            action="wake",
            message_template="Msg: {{val}}",
        )
        result = apply_mapping(mapping, "test", {"val": "ok"})
        assert result.text == "Msg: ok"
