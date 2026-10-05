"""Native image inputs must survive the complete OpenClaw turn unchanged."""
import base64
import json
import pytest
from pathlib import Path
from openclaw_adapter.images import extract_benchmark_images, native_image_argv
from openclaw_adapter.native_runtime import prepare_native_runtime, inspect_native_session

ENCODED = base64.b64encode(b"\x89PNG\r\n\x1a\ntransport-fixture").decode()

def runtime(tmp_path):
    return prepare_native_runtime(tools=(), model="vision", base_url="http://127.0.0.1:9999/v1", timeout_s=30, max_tokens=128, state_dir=tmp_path, image_input=True)

def test_native_image_config_and_complete_persistence(tmp_path):
    context = {"benchmark": "osworld", "screenshot_base64": ENCODED, "accessibility_tree": "tree"*30000}
    clean, images = extract_benchmark_images(context)
    paths = runtime(tmp_path)
    assert next(iter(json.loads(paths.config_path.read_text())["models"]["providers"].values()))["models"][0]["input"] == ["text", "image"]
    package = tmp_path / "openclaw"
    package.mkdir()
    (package / "package.json").write_text('{"name":"openclaw"}')
    binary = package / "openclaw.mjs"
    binary.write_text("")
    argv = native_image_argv(binary, "/node", tmp_path, ["openclaw", "agent", "--message", "look", "--model", "provider/vision", "--thinking", "high", "--agent", "benchmark", "--timeout", "30", "--session-id", "session-1"], images)
    assert argv[0] == "/node"
    payload = json.loads(Path(argv[-1]).read_text())
    assert payload["message"] == "look"
    assert payload["sessionId"] == "session-1"
    assert payload["images"] == [{"type":"image", "data":ENCODED, "mimeType":"image/png"}]
    assert clean["accessibility_tree"] == context["accessibility_tree"]
    assert "screenshot_base64" not in clean
    assert context["screenshot_base64"] == ENCODED

@pytest.mark.parametrize("image", [{"path":"/tmp/example.png"}, {"data_base64":"%%%", "media_type":"image/png"}, {"data_base64":"PHN2Zy8+", "media_type":"image/png"}])
def test_reject_invalid_visual_attachments(image):
    with pytest.raises(ValueError):
        extract_benchmark_images({"benchmark":"visualwebbench", "attachments":[image]})

@pytest.mark.parametrize("delivered", [None, "changed", ENCODED])
def test_native_transcript_checks_exact_image_bytes(tmp_path, delivered):
    paths = runtime(tmp_path)
    _, images = extract_benchmark_images({"benchmark":"osworld", "screenshot_base64":ENCODED})
    session = tmp_path/"agents/benchmark/sessions/turn.jsonl"
    session.parent.mkdir(parents=True)
    content = [] if delivered is None else [{"type":"image", "mimeType":"image/png", "data":delivered}]
    session.write_text("\n".join(json.dumps(record) for record in [
        {"type":"message", "message":{"role":"user", "content":content}},
        {"type":"message", "message":{"role":"assistant", "content":[{"type":"text", "text":"WAIT"}], "stopReason":"stop"}},
    ]))
    if delivered == ENCODED:
        assert inspect_native_session(paths, expected_images=images).status == "succeeded"
    else:
        with pytest.raises(RuntimeError, match="image bytes"):
            inspect_native_session(paths, expected_images=images)
