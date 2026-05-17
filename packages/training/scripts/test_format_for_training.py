from format_for_training import format_record


def test_format_record_renders_native_text_response():
    row = {
        "format": "eliza_native_v1",
        "boundary": "vercel_ai_sdk.generateText",
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
        "boundary": "vercel_ai_sdk.generateText",
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


def test_format_record_prepends_native_request_system():
    row = {
        "format": "eliza_native_v1",
        "boundary": "vercel_ai_sdk.generateText",
        "request": {
            "system": "system prompt",
            "messages": [{"role": "user", "content": "user prompt"}],
        },
        "response": {"text": "assistant response"},
        "metadata": {"task_type": "response"},
    }

    formatted = format_record(row)

    assert formatted == {
        "messages": [
            {"role": "system", "content": "system prompt"},
            {"role": "user", "content": "user prompt"},
            {"role": "assistant", "content": "assistant response"},
        ]
    }


def test_format_record_renders_native_system_prompt_request():
    row = {
        "format": "eliza_native_v1",
        "boundary": "vercel_ai_sdk.generateText",
        "request": {
            "system": "system prompt",
            "prompt": "user prompt",
        },
        "response": {"text": "assistant response"},
        "metadata": {"task_type": "response"},
    }

    formatted = format_record(row)

    assert formatted == {
        "messages": [
            {"role": "system", "content": "system prompt"},
            {"role": "user", "content": "user prompt"},
            {"role": "assistant", "content": "assistant response"},
        ]
    }


def test_format_record_rejects_prompt_only_native_rows():
    row = {
        "format": "eliza_native_v1",
        "boundary": "vercel_ai_sdk.generateText",
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


def test_format_record_rejects_native_rows_without_model_boundary():
    row = {
        "format": "eliza_native_v1",
        "request": {
            "messages": [{"role": "user", "content": "user prompt"}],
        },
        "response": {"text": "assistant response"},
        "metadata": {"task_type": "response"},
    }

    assert format_record(row) is None


def test_format_record_accepts_eliza1_trajectory_record():
    row = {
        "schema": "eliza.eliza1_trajectory_record.v1",
        "id": "traj-1",
        "split": "train",
        "task": "action_planner",
        "target": {"sftFormat": "messages"},
        "messages": [
            {"role": "user", "content": "send a reply"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call-1",
                        "type": "function",
                        "function": {
                            "name": "reply",
                            "arguments": '{"text":"hi"}',
                        },
                    }
                ],
            },
        ],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "reply",
                    "description": "Send a reply",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ],
        "actions": [],
        "quality": {"success": True},
        "source": {"dataset": "unit"},
        "metadata": {},
    }

    formatted = format_record(row)

    assert formatted is not None
    assert formatted["tools"] == row["tools"]
    assert formatted["messages"][-1]["tool_calls"][0]["function"]["name"] == "reply"


def test_format_record_rejects_repair_eval_trajectory_record():
    row = {
        "schema": "eliza.eliza1_trajectory_record.v1",
        "id": "repair-1",
        "split": "repair_eval",
        "task": "response",
        "target": {"sftFormat": "messages"},
        "messages": [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "failed answer"},
        ],
        "tools": [],
        "actions": [],
        "quality": {"success": False},
        "source": {"dataset": "unit"},
        "metadata": {},
    }

    assert format_record(row) is None


def test_format_record_accepts_plain_chat_messages_row():
    row = {
        "messages": [
            {"role": "system", "content": "system prompt"},
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
        ],
        "metadata": {"source_dataset": "unit"},
    }

    assert format_record(row) == {"messages": row["messages"]}


def test_format_record_accepts_flat_eliza_record_compatibility():
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
    assert formatted["messages"][0]["role"] == "system"
    assert "Available actions: REPLY" in formatted["messages"][0]["content"]
    assert formatted["messages"][-2] == {"role": "user", "content": "hello"}
    assert formatted["messages"][-1] == {"role": "assistant", "content": "hi"}
