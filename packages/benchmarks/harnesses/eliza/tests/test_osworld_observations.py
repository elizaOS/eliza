"""Image delivery and complete selected observations are required, not optional."""
import base64
from types import SimpleNamespace

import pytest
from eliza_adapter.osworld import ElizaBridgeOSWorldAgent
from eliza_adapter.visualwebbench import _image_media_type


class Client:
    def __init__(self):
        self.requests = []

    def send_message(self, **request):
        self.requests.append(request)
        return SimpleNamespace(text="WAIT", params={})


def test_visual_observation_preserves_bytes_tree_and_all_history(monkeypatch):
    monkeypatch.setenv("OSWORLD_INLINE_SCREENSHOT", "0")
    client = Client()
    agent = ElizaBridgeOSWorldAgent(client=client)
    agent._initialized = True
    agent.actions = [f"action-{i}" for i in range(12)]
    agent.thoughts = [f"thought-{i}" for i in range(12)]
    tree = "node\n" * 20000
    image = b"\x89PNG\r\n\x1a\n" + b"source image bytes"
    agent.predict("Inspect the desktop", {"screenshot": image, "accessibility_tree": tree})
    context = client.requests[0]["context"]
    assert base64.b64decode(context["screenshot_base64"]) == image
    assert context["accessibility_tree"] == tree
    assert context["previous_actions"] == [f"action-{i}" for i in range(12)]
    assert context["previous_thoughts"] == [f"thought-{i}" for i in range(12)]


@pytest.mark.parametrize("limits", [{"max_trajectory_length": 5}, {"a11y_tree_max_tokens": 500}])
def test_explicit_truncation_is_rejected(limits):
    with pytest.raises(ValueError, match="complete history"):
        ElizaBridgeOSWorldAgent(**limits)


def test_missing_screenshot_is_not_a_visual_run():
    agent = ElizaBridgeOSWorldAgent(client=Client())
    agent._initialized = True
    with pytest.raises(ValueError, match="requires screenshot"):
        agent.predict("Inspect the desktop", {})


def test_runtime_failure_is_not_retried_or_converted_to_wait():
    calls = []

    class FailedClient:
        def send_message(self, **request):
            calls.append(request)
            raise RuntimeError("vision unavailable")

    agent = ElizaBridgeOSWorldAgent(client=FailedClient(), observation_type="a11y_tree")
    agent._initialized = True
    with pytest.raises(RuntimeError, match="vision unavailable"):
        agent.predict("Inspect the desktop", {"accessibility_tree": "desktop"})
    assert len(calls) == 1


@pytest.mark.parametrize("data,mime", [
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"RIFF1234WEBP", "image/webp"),
])
def test_image_mime_is_detected_from_bytes(data, mime):
    assert _image_media_type(data) == mime


def test_markup_is_not_an_image():
    with pytest.raises(ValueError, match="requires PNG"):
        _image_media_type(b"<svg/>")
