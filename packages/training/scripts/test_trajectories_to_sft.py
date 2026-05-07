import json

import trajectories_to_sft as t


def test_examples_from_gemini_messages_preserves_metadata():
    row = {
        "messages": [
            {"role": "system", "content": "system"},
            {"role": "user", "content": "prompt"},
            {"role": "model", "content": '{"messageHandler":{"action":"IGNORE","contexts":[]}}'},
        ],
        "metadata": {"task_type": "should_respond", "source_dataset": "app_training"},
    }

    examples = list(t.examples_from_record(row))

    assert len(examples) == 1
    assert examples[0]["messages"][-1]["role"] == "assistant"
    assert examples[0]["metadata"]["task_type"] == "should_respond"
    assert examples[0]["metadata"]["source_dataset"] == "app_training"


def test_examples_from_legacy_trajectory_infers_action_planner():
    trajectory = {
        "trajectoryId": "traj-1",
        "agentId": "agent-1",
        "source": "runtime",
        "startTime": 1,
        "steps": [
            {
                "stepId": "step-1",
                "timestamp": 1,
                "llmCalls": [
                    {
                        "callId": "call-1",
                        "purpose": "planner",
                        "systemPrompt": "system",
                        "userPrompt": "prompt",
                        "response": json.dumps({"thought": "x", "actions": [{"name": "REPLY"}], "text": "hi"}),
                    }
                ],
            }
        ],
    }

    examples = list(t.examples_from_record(trajectory))

    assert len(examples) == 1
    assert examples[0]["metadata"]["task_type"] == "action_planner"
    assert examples[0]["metadata"]["trajectory_id"] == "traj-1"
    assert examples[0]["metadata"]["call_id"] == "call-1"


def test_read_jsonl_expands_records(tmp_path):
    path = tmp_path / "export.jsonl"
    path.write_text(
        json.dumps(
            {
                "format": "trajectory_harness_v1",
                "trajectoryId": "traj-1",
                "stepId": "step-1",
                "callId": "call-1",
                "purpose": "should_respond",
                "messages": [
                    {"role": "system", "content": "system"},
                    {"role": "user", "content": "prompt"},
                    {"role": "assistant", "content": '{"messageHandler":{"action":"RESPOND","contexts":[]}}'},
                ],
            }
        )
        + "\n",
        encoding="utf-8",
    )

    records = list(t._read_json_records(path))
    examples = [example for record in records for example in t.examples_from_record(record)]

    assert len(records) == 1
    assert len(examples) == 1
    assert examples[0]["metadata"]["task_type"] == "should_respond"
