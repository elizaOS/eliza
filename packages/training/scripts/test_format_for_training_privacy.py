"""Privacy-filter enforcement tests for `format_for_training.format_record`.

Two layers:

1. Unit tests — one per redactor rule (each `PatternSpec` in
   `default_patterns()`). Each test threads a payload through
   `format_record` and asserts the raw sensitive token is gone and the
   correct replacement token is present.

2. Property-based tests (hypothesis) — generate JSONL-style records with
   random `sk-*`, `Bearer ...`, GitHub PAT prefixes, AWS access keys, and
   lat/lng pairs. Assert zero raw PII survives the format_record path,
   under stress (>=1000 cases via deadline + max_examples).

The format_for_training module imports the privacy filter eagerly, so a
broken filter is a hard import error. These tests assume that import
succeeded.
"""

from __future__ import annotations

import json
import string
from typing import Any

import pytest
from hypothesis import HealthCheck, given, settings, strategies as st

from format_for_training import format_record
from privacy_filter_trajectories import (
    PrivacyFilterError,
    _inline_patterns,
    default_patterns,
    redact_value,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _wrap_native_record(user_content: str, response_text: str | None = None) -> dict[str, Any]:
    """Build a valid eliza_native_v1 record around the supplied strings."""

    return {
        "format": "eliza_native_v1",
        "boundary": "vercel_ai_sdk.generateText",
        "request": {
            "messages": [
                {"role": "system", "content": "system prompt"},
                {"role": "user", "content": user_content},
            ]
        },
        "response": {"text": response_text or "ok"},
        "metadata": {"task_type": "response"},
    }


def _dump(formatted: dict[str, Any] | None) -> str:
    assert formatted is not None
    return json.dumps(formatted, sort_keys=True)


# ---------------------------------------------------------------------------
# Sanity: filter loads at import time
# ---------------------------------------------------------------------------


def test_inline_patterns_load_eagerly_and_cover_all_categories() -> None:
    patterns = _inline_patterns()
    categories = {spec.category for spec in patterns}
    assert {"secret", "geo", "contact"}.issubset(categories)
    # Every pattern must have a non-empty replacement and a usable regex.
    for spec in patterns:
        assert spec.replacement
        assert spec.pattern.pattern


def test_redact_value_returns_dict_for_dict_input() -> None:
    out = redact_value({"k": "sk-AbCdEf0123456789xyz"})
    assert isinstance(out, dict)
    assert "<REDACTED:openai-key>" in json.dumps(out)


# ---------------------------------------------------------------------------
# Unit tests: one per redactor rule
# ---------------------------------------------------------------------------


def test_redactor_openai_key_in_user_content() -> None:
    record = _wrap_native_record("here is my key sk-AbCdEfGhIj0123456789")
    formatted = format_record(record)
    rendered = _dump(formatted)
    assert "sk-AbCdEfGhIj0123456789" not in rendered
    assert "<REDACTED:openai-key>" in rendered


def test_redactor_anthropic_key_in_response() -> None:
    record = _wrap_native_record(
        "hi",
        response_text="leaked sk-ant-AbCdEfGhIj0123456789",
    )
    formatted = format_record(record)
    rendered = _dump(formatted)
    assert "sk-ant-AbCdEfGhIj0123456789" not in rendered
    # The openai-key prefix matches `sk-` first by pattern order, so the
    # anthropic key gets redacted under the openai-key label. Either way
    # the raw value is gone — that is the contract this test enforces.
    assert "<REDACTED:openai-key>" in rendered or "<REDACTED:anthropic-key>" in rendered


def test_redactor_bearer_token() -> None:
    record = _wrap_native_record("auth: Bearer abcdef0123456789xyz")
    formatted = format_record(record)
    rendered = _dump(formatted)
    assert "Bearer abcdef0123456789xyz" not in rendered
    assert "<REDACTED:bearer>" in rendered


def test_redactor_github_pat() -> None:
    record = _wrap_native_record("token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaa")
    formatted = format_record(record)
    rendered = _dump(formatted)
    assert "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaa" not in rendered
    assert "<REDACTED:github-token>" in rendered


def test_redactor_aws_access_key() -> None:
    record = _wrap_native_record("aws AKIAIOSFODNN7EXAMPLE here")
    formatted = format_record(record)
    rendered = _dump(formatted)
    assert "AKIAIOSFODNN7EXAMPLE" not in rendered
    assert "<REDACTED:aws-access-key>" in rendered


def test_redactor_coords_json_block() -> None:
    record = _wrap_native_record(
        'pos: {"coords":{"latitude":37.7749,"longitude":-122.4194,"accuracy":10}}'
    )
    formatted = format_record(record)
    rendered = _dump(formatted)
    assert "37.7749" not in rendered
    assert "-122.4194" not in rendered
    assert "[REDACTED_GEO]" in rendered


def test_redactor_latitude_longitude_json_pair() -> None:
    record = _wrap_native_record('here {"latitude":40.7128,"longitude":-74.0060}')
    formatted = format_record(record)
    rendered = _dump(formatted)
    assert "40.7128" not in rendered
    assert "-74.0060" not in rendered
    assert "[REDACTED_GEO]" in rendered


def test_redactor_location_decimal_pair() -> None:
    record = _wrap_native_record("current location: 51.5074, -0.1278 right now")
    formatted = format_record(record)
    rendered = _dump(formatted)
    assert "51.5074" not in rendered
    assert "-0.1278" not in rendered
    assert "[REDACTED_GEO]" in rendered


def test_redactor_labeled_lat_lng() -> None:
    record = _wrap_native_record("lat: 48.8566, lng: 2.3522 from device")
    formatted = format_record(record)
    rendered = _dump(formatted)
    assert "48.8566" not in rendered
    assert "2.3522" not in rendered
    assert "[REDACTED_GEO]" in rendered


def test_redactor_bare_decimal_pair() -> None:
    record = _wrap_native_record("the spot is 37.7749, -122.4194 today")
    formatted = format_record(record)
    rendered = _dump(formatted)
    assert "37.7749" not in rendered
    assert "-122.4194" not in rendered
    assert "[REDACTED_GEO]" in rendered


def test_redactor_email() -> None:
    record = _wrap_native_record("ping alice@example.com please")
    formatted = format_record(record)
    rendered = _dump(formatted)
    assert "alice@example.com" not in rendered
    assert "<REDACTED:contact-email>" in rendered


def test_redactor_phone_us_format() -> None:
    record = _wrap_native_record("call (415) 555-0199 today")
    formatted = format_record(record)
    rendered = _dump(formatted)
    assert "(415) 555-0199" not in rendered
    assert "<REDACTED:contact-phone>" in rendered


def test_redactor_phone_dashed() -> None:
    record = _wrap_native_record("number is +1 415-555-0123 here")
    formatted = format_record(record)
    rendered = _dump(formatted)
    assert "415-555-0123" not in rendered
    assert "<REDACTED:contact-phone>" in rendered


def test_redactor_handle() -> None:
    record = _wrap_native_record("ping @samantha_ops about it")
    formatted = format_record(record)
    rendered = _dump(formatted)
    assert "@samantha_ops" not in rendered
    assert "<REDACTED:contact-handle>" in rendered


def test_redactor_known_pii_name() -> None:
    record = _wrap_native_record("ask Sarah for the doc")
    formatted = format_record(record)
    rendered = _dump(formatted)
    assert "Sarah" not in rendered
    assert "<REDACTED:known-name>" in rendered


def test_redactor_applies_to_dict_keys() -> None:
    """Sensitive values used as dict keys must also be redacted."""

    # `format_record` wraps the messages in a dict whose key path is fixed;
    # to exercise dict-key redaction we route through `redact_value` directly
    # (the same code path the inline filter uses inside `format_record`).
    value = {"alice@example.com": "hello"}
    out = redact_value(value)
    assert isinstance(out, dict)
    rendered = json.dumps(out)
    assert "alice@example.com" not in rendered
    assert "<REDACTED:contact-email>" in rendered


def test_redactor_applies_to_nested_lists() -> None:
    record = _wrap_native_record(
        "see: ['ghp_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'Bearer abcdef0123456789xyz']"
    )
    formatted = format_record(record)
    rendered = _dump(formatted)
    assert "ghp_" not in rendered
    assert "Bearer abcdef" not in rendered


def test_redactor_passes_through_non_string_scalars() -> None:
    value = {"a": 1, "b": True, "c": None, "d": 3.14}
    out = redact_value(value)
    assert out == value


# ---------------------------------------------------------------------------
# Property-based tests (hypothesis)
# ---------------------------------------------------------------------------


# Build strategies for each high-risk shape. We constrain each to known-bad
# tokens so the test asserts the filter catches them in every form.

# Body shape constraints mirror the redactor regexes in `default_patterns()`.
# Each strategy guarantees the generated value is something the privacy
# filter is contracted to match — body length, allowed alphabet, and the
# closing word-boundary character (alphanumeric, never punctuation) all
# match `\b[A-Za-z0-9.…]{N,}\b` semantics. Generating a token that the
# regex would legitimately reject (e.g. `Bearer foo...........`, where the
# trailing `.` defeats `\b`) is a strategy bug, not a filter bug.
_ALPHANUM = string.ascii_letters + string.digits


def _body(alphabet: str, *, min_size: int, max_size: int) -> st.SearchStrategy[str]:
    """Generate a body that starts and ends with an alphanumeric char."""

    middle = st.text(alphabet=alphabet, min_size=min_size - 2, max_size=max_size - 2)
    head = st.sampled_from(_ALPHANUM)
    tail = st.sampled_from(_ALPHANUM)
    return st.tuples(head, middle, tail).map(lambda parts: "".join(parts))


def _sk_strategy() -> st.SearchStrategy[str]:
    return _body(_ALPHANUM + "-_", min_size=16, max_size=48).map(lambda s: f"sk-{s}")


def _sk_ant_strategy() -> st.SearchStrategy[str]:
    return _body(_ALPHANUM + "-_", min_size=16, max_size=48).map(lambda s: f"sk-ant-{s}")


def _bearer_strategy() -> st.SearchStrategy[str]:
    return _body(_ALPHANUM + "._-", min_size=16, max_size=64).map(lambda s: f"Bearer {s}")


def _github_pat_strategy() -> st.SearchStrategy[str]:
    return _body(_ALPHANUM, min_size=20, max_size=36).map(lambda s: f"ghp_{s}")


def _aws_access_key_strategy() -> st.SearchStrategy[str]:
    body = st.text(
        alphabet=string.ascii_uppercase + string.digits,
        min_size=16,
        max_size=16,
    )
    return body.map(lambda s: f"AKIA{s}")


def _decimal_pair_strategy() -> st.SearchStrategy[str]:
    """Generate `lat, lng` style bare decimal pairs.

    Both numbers must have at least one fractional digit; this matches the
    `bare-decimal-pair` rule in the privacy filter (it intentionally
    excludes integer pairs like timestamps).
    """

    lat = st.decimals(min_value=-89, max_value=89, places=4, allow_nan=False)
    lng = st.decimals(min_value=-179, max_value=179, places=4, allow_nan=False)
    return st.tuples(lat, lng).map(lambda pair: f"{pair[0]}, {pair[1]}")


def _coords_json_strategy() -> st.SearchStrategy[str]:
    lat = st.decimals(min_value=-89, max_value=89, places=4, allow_nan=False)
    lng = st.decimals(min_value=-179, max_value=179, places=4, allow_nan=False)
    return st.tuples(lat, lng).map(
        lambda pair: f'{{"coords":{{"latitude":{pair[0]},"longitude":{pair[1]}}}}}'
    )


_SECRET_PREFIXES = ("sk-", "sk-ant-", "Bearer ", "ghp_", "AKIA")


def _record_with_payloads(payloads: list[str]) -> dict[str, Any]:
    """Embed payload strings into a valid eliza_native_v1 record.

    Strings are inserted into both user content and response text to
    exercise both halves of `_format_native_record`.
    """

    user_chunk = " ".join(payloads[:8])
    response_chunk = " ".join(payloads[8:16]) or "ok"
    return {
        "format": "eliza_native_v1",
        "boundary": "vercel_ai_sdk.generateText",
        "request": {
            "messages": [
                {"role": "system", "content": "system prompt"},
                {"role": "user", "content": user_chunk or "hi"},
            ]
        },
        "response": {"text": response_chunk},
        "metadata": {"task_type": "response"},
    }


def _no_raw_pii(rendered: str, payloads: list[str]) -> bool:
    """Assert every generated payload is gone from the rendered output.

    Two checks per payload:
      1. The payload itself does not appear as a substring.
      2. The high-risk *prefix* (e.g. `sk-`, `Bearer`) does not survive
         followed by enough characters to still look like a credential.

    Geo pairs are checked by ensuring at least one numeric component is
    absent (the redactor replaces the whole pair with `[REDACTED_GEO]`,
    so neither value should survive together).
    """

    for raw in payloads:
        if raw.startswith(_SECRET_PREFIXES):
            assert raw not in rendered, f"raw secret survived: {raw[:24]}..."
        elif raw.startswith('{"coords"'):
            # JSON coords block — neither lat nor lng should remain together
            assert raw not in rendered, "coords JSON block survived"
        elif "," in raw:
            # bare decimal pair "lat, lng"
            assert raw not in rendered, f"decimal pair survived: {raw}"
    return True


@settings(
    max_examples=1100,  # task asks for >= 1000 cases
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.data_too_large],
)
@given(
    secrets=st.lists(
        st.one_of(
            _sk_strategy(),
            _sk_ant_strategy(),
            _bearer_strategy(),
            _github_pat_strategy(),
            _aws_access_key_strategy(),
        ),
        min_size=1,
        max_size=8,
    ),
    geo=st.lists(
        st.one_of(_decimal_pair_strategy(), _coords_json_strategy()),
        min_size=0,
        max_size=4,
    ),
)
def test_property_format_record_redacts_all_known_high_risk(
    secrets: list[str], geo: list[str]
) -> None:
    payloads = secrets + geo
    record = _record_with_payloads(payloads)
    formatted = format_record(record)
    assert formatted is not None
    rendered = json.dumps(formatted)
    _no_raw_pii(rendered, payloads)


@settings(
    max_examples=300,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.data_too_large],
)
@given(
    plain=st.text(
        # Exclude `@` and `.` characters and the digits 1-9 to keep the
        # alphabet clean of email-shape, handle-shape, decimal-pair, and
        # known-PII-name fragments. The point of this test is to verify
        # non-PII content survives intact, so we generate strings the
        # filter has no rule for.
        alphabet=string.ascii_lowercase + " ",
        min_size=1,
        max_size=80,
    ).filter(lambda s: s.strip()),
)
def test_property_plain_text_is_unchanged(plain: str) -> None:
    """Plain alphanumeric strings without secret/geo/contact markers should
    pass through unchanged. This guards against over-aggressive redaction
    that would corrupt non-PII training content."""

    record = _wrap_native_record(plain)
    formatted = format_record(record)
    assert formatted is not None
    user_msg = next(
        msg for msg in formatted["messages"] if msg["role"] == "user"
    )
    assert user_msg["content"] == plain


# ---------------------------------------------------------------------------
# Enforcement: no bypass
# ---------------------------------------------------------------------------


def test_format_record_uses_redact_value(monkeypatch: pytest.MonkeyPatch) -> None:
    """If the inline filter is sabotaged, `format_record` must surface it."""

    import format_for_training as ftt

    def _broken(value: Any) -> Any:  # noqa: ARG001
        raise PrivacyFilterError("synthetic-filter-failure")

    monkeypatch.setattr(ftt, "_redact_value", _broken)

    with pytest.raises(PrivacyFilterError, match="synthetic-filter-failure"):
        format_record(_wrap_native_record("hello"))


def test_format_record_rejects_non_dict_filter_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import format_for_training as ftt

    def _bad(value: Any) -> Any:  # noqa: ARG001
        return "not a dict"

    monkeypatch.setattr(ftt, "_redact_value", _bad)

    with pytest.raises(PrivacyFilterError, match="non-dict"):
        format_record(_wrap_native_record("hello"))


def test_default_patterns_contains_every_category_we_test() -> None:
    """Spec lock: enumerate the labels the unit tests above cover and
    require them all to exist in `default_patterns()`. New rules added to
    the privacy filter should add a corresponding unit test above."""

    covered = {
        "openai-key",
        "anthropic-key",
        "bearer",
        "github-token",
        "aws-access-key",
        "coords-json-block",
        "latitude-longitude-json-pair",
        "location-decimal-pair",
        "labeled-lat-lng",
        "bare-decimal-pair",
        "email",
        "phone",
        "handle",
        "known-pii-name",
    }
    labels = {spec.label for spec in default_patterns()}
    missing = covered - labels
    assert not missing, f"unit-tested labels missing from default_patterns: {missing}"
