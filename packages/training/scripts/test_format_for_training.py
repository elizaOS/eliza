from format_for_training import format_record


def test_format_record_accepts_trajectory_messages_with_model_role():
    row = {
        "messages": [
            {"role": "system", "content": "system prompt"},
            {"role": "user", "content": "user prompt"},
            {"role": "model", "content": '{"messageHandler":{"action":"RESPOND","contexts":[]}}'},
        ],
        "metadata": {"task_type": "should_respond", "source_dataset": "runtime_trajectories"},
    }

    formatted = format_record(row)

    assert formatted == {
        "messages": [
            {"role": "system", "content": "system prompt"},
            {"role": "user", "content": "user prompt"},
            {"role": "assistant", "content": '{"messageHandler":{"action":"RESPOND","contexts":[]}}'},
        ]
    }


def test_format_record_rejects_prompt_only_messages():
    row = {
        "messages": [
            {"role": "system", "content": "system prompt"},
            {"role": "user", "content": "user prompt"},
        ],
        "metadata": {"task_type": "reply", "source_dataset": "runtime_trajectories"},
    }

    assert format_record(row) is None


def test_format_record_keeps_flat_eliza_record_path():
    row = {
        "roomName": "room",
        "agentId": "Eliza",
        "memoryEntries": [],
        "currentMessage": {"role": "user", "speaker": "u", "content": "hello", "channel": "dm"},
        "expectedResponse": "thought: greet\ntext: hi",
        "availableActions": ["REPLY"],
        "metadata": {"task_type": "reply", "source_dataset": "unit"},
    }

    formatted = format_record(row)

    assert formatted is not None
    assert formatted["messages"][-1] == {"role": "assistant", "content": "thought: greet\ntext: hi"}
