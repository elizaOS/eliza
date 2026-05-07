import json

import trajectories_to_sft as t


def native_row(**overrides):
    row = {
        "format": "eliza_native_v1",
        "schemaVersion": 1,
        "boundary": "vercel_ai_sdk.generateText",
        "trajectoryId": "traj-1",
        "stepId": "step-1",
        "callId": "call-1",
        "purpose": "should_respond",
        "request": {
            "messages": [
                {"role": "system", "content": "system"},
                {"role": "user", "content": "prompt"},
            ],
            "tools": {
                "reply": {
                    "description": "Send a reply",
                    "parameters": {"type": "object", "properties": {}},
                }
            },
        },
        "response": {
            "text": json.dumps(
                {"messageHandler": {"action": "IGNORE", "contexts": []}}
            )
        },
        "metadata": {
            "task_type": "should_respond",
            "source_dataset": "runtime_trajectory_boundary",
            "trajectory_id": "traj-1",
            "step_id": "step-1",
            "call_id": "call-1",
        },
    }
    row.update(overrides)
    return row


def test_examples_from_native_row_preserves_boundary():
    row = native_row()

    examples = list(t.examples_from_record(row))

    assert len(examples) == 1
    assert examples[0]["format"] == "eliza_native_v1"
    assert examples[0]["request"]["messages"][1]["content"] == "prompt"
    assert examples[0]["request"]["tools"]["reply"]["description"] == "Send a reply"
    assert examples[0]["response"]["text"] == row["response"]["text"]
    assert examples[0]["metadata"]["task_type"] == "should_respond"


def test_examples_from_native_tool_call_row_accepts_empty_text():
    row = native_row(
        response={
            "text": "",
            "toolCalls": [
                {
                    "toolCallId": "tc-1",
                    "toolName": "reply",
                    "input": {"text": "hi"},
                }
            ],
        },
        purpose="action_planner",
        metadata={},
    )

    examples = list(t.examples_from_record(row))

    assert len(examples) == 1
    assert examples[0]["metadata"]["task_type"] == "action_planner"
    assert examples[0]["response"]["toolCalls"][0]["toolName"] == "reply"


def test_rejects_non_native_rows():
    row = {
        "messages": [
            {"role": "system", "content": "system"},
            {"role": "user", "content": "prompt"},
            {"role": "assistant", "content": "response"},
        ],
        "metadata": {"task_type": "should_respond"},
    }

    assert list(t.examples_from_record(row)) == []


def test_read_jsonl_expands_native_records(tmp_path):
    path = tmp_path / "export.jsonl"
    path.write_text(json.dumps(native_row()) + "\n", encoding="utf-8")

    records = list(t._read_json_records(path))
    examples = [example for record in records for example in t.examples_from_record(record)]

    assert len(records) == 1
    assert len(examples) == 1
    assert examples[0]["metadata"]["call_id"] == "call-1"
