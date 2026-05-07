from format_for_training import format_record


def test_format_record_renders_native_text_response():
    row = {
        "format": "eliza_native_v1",
        "request": {
            "messages": [
                {"role": "system", "content": "system prompt"},
                {"role": "user", "content": "user prompt"},
            ]
        },
        "response": {
            "text": '{"messageHandler":{"action":"RESPOND","contexts":[]}}'
        },
        "metadata": {"task_type": "should_respond"},
    }

    formatted = format_record(row)

    assert formatted == {
        "messages": [
            {"role": "system", "content": "system prompt"},
            {"role": "user", "content": "user prompt"},
            {
                "role": "assistant",
                "content": '{"messageHandler":{"action":"RESPOND","contexts":[]}}',
            },
        ]
    }


def test_format_record_renders_native_tool_call_response():
    row = {
        "format": "eliza_native_v1",
        "request": {
            "messages": [{"role": "user", "content": "send a reply"}],
            "tools": {
                "reply": {
                    "description": "Send a reply",
                    "parameters": {"type": "object", "properties": {}},
                }
            },
        },
        "response": {
            "text": "",
            "toolCalls": [
                {
                    "toolCallId": "tc-1",
                    "toolName": "reply",
                    "input": {"text": "hi"},
                }
            ],
        },
        "metadata": {"task_type": "action_planner"},
    }

    formatted = format_record(row)

    assert formatted is not None
    assert formatted["tools"] == row["request"]["tools"]
    assert formatted["messages"][-1] == {
        "role": "assistant",
        "content": "",
        "tool_calls": [
            {
                "id": "tc-1",
                "type": "function",
                "function": {
                    "name": "reply",
                    "arguments": '{"text": "hi"}',
                },
            }
        ],
    }


def test_format_record_rejects_prompt_only_native_rows():
    row = {
        "format": "eliza_native_v1",
        "request": {
            "messages": [
                {"role": "system", "content": "system prompt"},
                {"role": "user", "content": "user prompt"},
            ]
        },
        "response": {"text": ""},
        "metadata": {"task_type": "response"},
    }

    assert format_record(row) is None


def test_format_record_keeps_flat_eliza_record_compatibility():
    row = {
        "roomName": "room",
        "agentId": "Eliza",
        "memoryEntries": [],
        "currentMessage": {
            "role": "user",
            "speaker": "u",
            "content": "hello",
            "channel": "dm",
        },
        "expectedResponse": "hi",
        "availableActions": ["REPLY"],
        "metadata": {"task_type": "reply", "source_dataset": "unit"},
    }

    formatted = format_record(row)

    assert formatted is not None
    assert formatted["messages"][-1] == {"role": "assistant", "content": "hi"}
