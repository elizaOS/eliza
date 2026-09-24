"""Visual benchmark bytes belong in native user content, never system text."""
import base64
import copy

import pytest
from hermes_adapter.client import HermesClient
from hermes_adapter.native_runtime import NativeRuntimeError, _conversation_inputs


@pytest.mark.parametrize("benchmark", ["osworld", "visualwebbench"])
def test_image_reaches_native_user_content_without_system_base64(tmp_path, benchmark):
    encoded = base64.b64encode(b"\x89PNG\r\n\x1a\nfixture-bytes").decode()
    context = {"benchmark": benchmark, "accessibility_tree": "complete tree", "messages": [
        {"role": "user", "content": "older request"},
        {"role": "assistant", "content": "older response"},
        {"role": "user", "content": [{"type": "text", "text": "look"}]},
    ]}
    if benchmark == "osworld":
        context["screenshot_base64"] = encoded
    else:
        context["attachments"] = [{"kind": "image", "media_type": "image/png", "data_base64": encoded}]
    original = copy.deepcopy(context)
    client = HermesClient(repo_path=tmp_path, provider="openai", model="vision-test", api_key="fixture", base_url="http://127.0.0.1:1234/v1")
    try:
        payload = client.build_send_message_payload("look", context)
        user, system, history = _conversation_inputs(payload)
        assert user == [{"type": "text", "text": "look"}, {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{encoded}"}}]
        assert history == original["messages"][:2]
        assert encoded not in system
        assert "complete tree" in system
        assert context == original
    finally:
        client.close()


@pytest.mark.parametrize("image", [
    {"path": "/tmp/image.png", "media_type": "image/png"},
    {"data_base64": "%%%", "media_type": "image/png"},
    {"data_base64": "PHN2Zy8+", "media_type": "image/png"},
])
def test_invalid_visual_input_is_not_sent_as_text(tmp_path, image):
    client = HermesClient(repo_path=tmp_path, provider="openai", model="vision-test", api_key="fixture", base_url="http://127.0.0.1:1234/v1")
    try:
        with pytest.raises(NativeRuntimeError):
            client.build_send_message_payload("look", {"benchmark": "visualwebbench", "attachments": [image]})
    finally:
        client.close()
