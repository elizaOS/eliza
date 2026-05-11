import json
import subprocess
import sys
from pathlib import Path

import pytest

import privacy_filter_trajectories as p


def _read_jsonl(path: Path) -> list[object]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def test_filter_json_value_recurses_values_lists_and_keys(tmp_path: Path) -> None:
    ledger = tmp_path / "ledger.jsonl"
    stats = p.FilterStats()
    config = p.RuntimeConfig(patterns=p.default_patterns())
    location = p.SourceLocation(
        file="sample.jsonl",
        line=1,
        record_index=1,
        record_id="traj-1",
    )
    record = {
        "trajectoryId": "traj-1",
        "alice@example.com": {
            "messages": [
                "email bob@example.com or call +1 415-555-0123",
                "key sk-AbCdEf0123456789xyz at 37.7749, -122.4194",
                {"handle": "ping @samantha_ops"},
            ],
        },
    }

    with ledger.open("w", encoding="utf-8") as f:
        cleaned = p.filter_json_value(
            record,
            path="$",
            location=location,
            stats=stats,
            ledger=f,
            config=config,
        )

    dumped = json.dumps(cleaned)
    assert "alice@example.com" not in dumped
    assert "bob@example.com" not in dumped
    assert "+1 415-555-0123" not in dumped
    assert "sk-AbCdEf0123456789xyz" not in dumped
    assert "37.7749" not in dumped
    assert "@samantha_ops" not in dumped
    assert "<REDACTED:contact-email>" in dumped
    assert "<REDACTED:contact-phone>" in dumped
    assert "<REDACTED:openai-key>" in dumped
    assert "[REDACTED_GEO]" in dumped
    assert stats.redactions_by_category["contact"] == 4
    assert stats.redactions_by_category["secret"] == 1
    assert stats.redactions_by_category["geo"] == 1

    ledger_rows = _read_jsonl(ledger)
    assert len(ledger_rows) == stats.redactions_total
    assert all("value_sha256" in row for row in ledger_rows if isinstance(row, dict))
    ledger_text = ledger.read_text(encoding="utf-8")
    assert "alice@example.com" not in ledger_text
    assert "bob@example.com" not in ledger_text


def test_filter_paths_writes_redacted_jsonl_ledger_and_stats(tmp_path: Path) -> None:
    source_dir = tmp_path / "in"
    nested = source_dir / "nested"
    nested.mkdir(parents=True)
    (source_dir / "records.jsonl").write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "format": "eliza_native_v1",
                        "trajectoryId": "traj-1",
                        "request": {
                            "messages": [
                                {
                                    "role": "user",
                                    "content": "Bearer abcdef0123456789xyz and Sarah",
                                }
                            ]
                        },
                    }
                ),
                json.dumps({"trajectory_id": "traj-2", "text": "lat: 40.7128, lng: -74.0060"}),
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    (nested / "more.json").write_text(
        json.dumps({"records": [{"id": "row-3", "text": "call (415) 555-0199"}]}),
        encoding="utf-8",
    )
    out = tmp_path / "redacted.jsonl"
    ledger = tmp_path / "ledger.jsonl"
    stats_path = tmp_path / "stats.json"

    stats = p.filter_paths(
        [str(source_dir)],
        output_jsonl=out,
        ledger_jsonl=ledger,
        stats_json=stats_path,
        strict=True,
        config=p.RuntimeConfig(patterns=p.default_patterns()),
    )

    rows = _read_jsonl(out)
    assert len(rows) == 3
    rendered = json.dumps(rows)
    assert "Bearer abcdef0123456789xyz" not in rendered
    assert "Sarah" not in rendered
    assert "40.7128" not in rendered
    assert "(415) 555-0199" not in rendered
    assert stats.records_written == 3
    assert stats.residual_total == 0

    stats_json = json.loads(stats_path.read_text(encoding="utf-8"))
    assert stats_json["records_written"] == 3
    assert stats_json["redactions"]["by_label"]["bearer"] == 1
    assert stats_json["redactions"]["by_label"]["known-pii-name"] == 1
    assert stats_json["redactions"]["by_label"]["phone"] == 1
    assert ledger.read_text(encoding="utf-8").count("\n") == stats.redactions_total


def test_backend_hook_applies_span_redactions_without_dependency(tmp_path: Path) -> None:
    hook = tmp_path / "hook.py"
    hook.write_text(
        """
import json
import sys

payload = json.loads(sys.stdin.read())
text = payload["text"]
start = text.find("Alice")
if start == -1:
    print(json.dumps({"redactions": []}))
else:
    print(json.dumps({
        "redactions": [{
            "start": start,
            "end": start + len("Alice"),
            "label": "person-name",
            "replacement": "<REDACTED:person-name>"
        }]
    }))
""".strip(),
        encoding="utf-8",
    )
    source = tmp_path / "in.jsonl"
    source.write_text(json.dumps({"text": "Alice met the owner"}) + "\n", encoding="utf-8")
    out = tmp_path / "out.jsonl"
    ledger = tmp_path / "ledger.jsonl"
    stats_path = tmp_path / "stats.json"

    p.filter_paths(
        [str(source)],
        output_jsonl=out,
        ledger_jsonl=ledger,
        stats_json=stats_path,
        config=p.RuntimeConfig(
            patterns=p.default_patterns(),
            backend_command=f"{sys.executable} {hook}",
            backend_name="openai-privacy-filter-test",
            backend_model="privacy-test-model",
        ),
    )

    rows = _read_jsonl(out)
    assert rows == [{"text": "<REDACTED:person-name> met the owner"}]
    stats = json.loads(stats_path.read_text(encoding="utf-8"))
    assert stats["backend"]["enabled"] is True
    assert stats["backend"]["calls"] == 2
    assert stats["backend"]["model"] == "privacy-test-model"
    assert stats["redactions"]["by_source"]["backend"] == 1
    assert "Alice" not in ledger.read_text(encoding="utf-8")


def test_backend_receives_regex_redacted_text(tmp_path: Path) -> None:
    hook = tmp_path / "hook.py"
    capture = tmp_path / "capture.jsonl"
    hook.write_text(
        f"""
import json
import pathlib
import sys

payload = json.loads(sys.stdin.read())
pathlib.Path({str(capture)!r}).open("a", encoding="utf-8").write(json.dumps(payload) + "\\n")
print(json.dumps({{"text": payload["text"]}}))
""".strip(),
        encoding="utf-8",
    )
    source = tmp_path / "in.jsonl"
    source.write_text(
        json.dumps({"text": "send sk-AbCdEf0123456789xyz to Alice"}) + "\n",
        encoding="utf-8",
    )

    p.filter_paths(
        [str(source)],
        output_jsonl=tmp_path / "out.jsonl",
        ledger_jsonl=tmp_path / "ledger.jsonl",
        stats_json=tmp_path / "stats.json",
        config=p.RuntimeConfig(
            patterns=p.default_patterns(),
            backend_command=f"{sys.executable} {hook}",
        ),
    )

    captured = capture.read_text(encoding="utf-8")
    assert "sk-AbCdEf0123456789xyz" not in captured
    assert "<REDACTED:openai-key>" in captured


def test_strict_mode_fails_on_backend_residual_high_risk(tmp_path: Path) -> None:
    hook = tmp_path / "leaky_hook.py"
    hook.write_text(
        """
import json
import sys

json.loads(sys.stdin.read())
print(json.dumps({"text": "backend leaked Bearer abcdef0123456789xyz"}))
""".strip(),
        encoding="utf-8",
    )
    source = tmp_path / "in.jsonl"
    source.write_text(json.dumps({"text": "safe text"}) + "\n", encoding="utf-8")

    with pytest.raises(p.PrivacyFilterError, match="residual high-risk"):
        p.filter_paths(
            [str(source)],
            output_jsonl=tmp_path / "out.jsonl",
            ledger_jsonl=tmp_path / "ledger.jsonl",
            stats_json=tmp_path / "stats.json",
            strict=True,
            config=p.RuntimeConfig(
                patterns=p.default_patterns(),
                backend_command=f"{sys.executable} {hook}",
            ),
        )

    stats = json.loads((tmp_path / "stats.json").read_text(encoding="utf-8"))
    assert stats["residual_high_risk"]["total"] >= 1
    assert stats["residual_high_risk"]["by_label"]["bearer"] >= 1


def test_cli_returns_two_for_strict_residual(tmp_path: Path) -> None:
    hook = tmp_path / "leaky_hook.py"
    hook.write_text(
        """
import json
import sys

json.loads(sys.stdin.read())
print(json.dumps({"text": "leak ghp_aaaaaaaaaaaaaaaaaaaaaaaaaa"}))
""".strip(),
        encoding="utf-8",
    )
    source = tmp_path / "in.jsonl"
    source.write_text(json.dumps({"text": "safe"}) + "\n", encoding="utf-8")
    out = tmp_path / "out.jsonl"
    ledger = tmp_path / "ledger.jsonl"
    stats_path = tmp_path / "stats.json"

    code = p.main(
        [
            "--input",
            str(source),
            "--output-jsonl",
            str(out),
            "--ledger-jsonl",
            str(ledger),
            "--stats-json",
            str(stats_path),
            "--strict",
            "--backend-command",
            f"{sys.executable} {hook}",
        ]
    )

    assert code == 2
    assert json.loads(stats_path.read_text(encoding="utf-8"))["residual_high_risk"]["total"] >= 1


def test_script_help_runs() -> None:
    result = subprocess.run(
        [sys.executable, p.__file__, "--help"],
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0
    assert "--openai-privacy-filter-command" in result.stdout
