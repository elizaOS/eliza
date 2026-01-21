from __future__ import annotations

import logging

from elizaos.logger import _redaction_processor


def test_redaction_processor_redacts_common_secret_keys(monkeypatch) -> None:
    monkeypatch.setenv("ELIZA_LOG_REDACT", "true")
    monkeypatch.delenv("ELIZA_LOG_REDACT_KEYS", raising=False)

    event: dict[str, object] = {
        "message": "hello",
        "token": "abc",
        "nested": {"password": "pw", "ok": "yes"},
        "list": [{"apiKey": "k1"}, {"value": "v"}],
    }

    redacted = _redaction_processor(logging.getLogger("test"), "info", event)
    assert redacted["token"] == "[REDACTED]"
    assert isinstance(redacted["nested"], dict)
    assert redacted["nested"]["password"] == "[REDACTED]"
    assert redacted["nested"]["ok"] == "yes"
    assert isinstance(redacted["list"], list)
    assert redacted["list"][0]["apiKey"] == "[REDACTED]"


def test_redaction_processor_can_be_disabled(monkeypatch) -> None:
    monkeypatch.setenv("ELIZA_LOG_REDACT", "false")

    event: dict[str, object] = {"token": "abc"}
    out = _redaction_processor(logging.getLogger("test"), "info", event)
    assert out["token"] == "abc"


def test_redaction_processor_supports_custom_keys(monkeypatch) -> None:
    monkeypatch.setenv("ELIZA_LOG_REDACT", "true")
    monkeypatch.setenv("ELIZA_LOG_REDACT_KEYS", "email, phone ")

    event: dict[str, object] = {"email": "user@example.com", "phone": "555-5555"}
    out = _redaction_processor(logging.getLogger("test"), "info", event)
    assert out["email"] == "[REDACTED]"
    assert out["phone"] == "[REDACTED]"
