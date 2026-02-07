"""Tests for CLI utilities."""

from __future__ import annotations

from elizaos_plugin_cli.types import (
    CliContext,
    CommonCommandOptions,
    ProgressReporter,
)
from elizaos_plugin_cli.utils import (
    DEFAULT_CLI_NAME,
    DEFAULT_CLI_VERSION,
    format_bytes,
    format_cli_command,
    format_duration,
    parse_duration,
    parse_timeout_ms,
    truncate_string,
)
from elizaos_plugin_cli import PLUGIN_NAME


# ---------------------------------------------------------------------------
# Duration parsing
# ---------------------------------------------------------------------------


def test_parse_duration_seconds() -> None:
    assert parse_duration("1s") == 1_000
    assert parse_duration("90s") == 90_000
    assert parse_duration("0s") == 0


def test_parse_duration_minutes() -> None:
    assert parse_duration("30m") == 30 * 60_000
    assert parse_duration("1min") == 60_000


def test_parse_duration_hours() -> None:
    assert parse_duration("1h") == 3_600_000
    assert parse_duration("2hr") == 7_200_000


def test_parse_duration_days() -> None:
    assert parse_duration("2d") == 2 * 86_400_000
    assert parse_duration("1day") == 86_400_000


def test_parse_duration_compound() -> None:
    assert parse_duration("1h30m") == 5_400_000   # 90 minutes
    assert parse_duration("2d12h") == 216_000_000  # 60 hours


def test_parse_duration_milliseconds() -> None:
    assert parse_duration("500ms") == 500
    assert parse_duration("1000") == 1000


def test_parse_duration_invalid() -> None:
    assert parse_duration("") is None
    assert parse_duration("abc") is None
    assert parse_duration("1x") is None
    assert parse_duration("h1") is None


def test_parse_duration_whitespace() -> None:
    assert parse_duration("  1h  ") == 3_600_000
    assert parse_duration(" 30m ") == 1_800_000


# ---------------------------------------------------------------------------
# Format utilities
# ---------------------------------------------------------------------------


def test_format_duration_ranges() -> None:
    assert format_duration(450) == "450ms"
    assert format_duration(1500) == "1.5s"
    assert format_duration(90_000) == "1.5m"
    assert format_duration(5_400_000) == "1.5h"
    assert format_duration(172_800_000) == "2.0d"


def test_format_bytes_various() -> None:
    assert format_bytes(0) == "0 B"
    assert format_bytes(512) == "512 B"
    assert format_bytes(1024) == "1.0 KB"
    assert format_bytes(1536) == "1.5 KB"
    assert format_bytes(1048576) == "1.0 MB"
    assert format_bytes(1073741824) == "1.0 GB"
    assert format_bytes(1099511627776) == "1.0 TB"


def test_truncate_string() -> None:
    assert truncate_string("hello", 10) == "hello"
    assert truncate_string("hello world!", 8) == "hello..."
    assert truncate_string("ab", 2) == "ab"
    assert truncate_string("abcdef", 3) == "..."


def test_parse_timeout_ms() -> None:
    assert parse_timeout_ms("30s", 5000) == 30_000
    assert parse_timeout_ms(None, 5000) == 5000
    assert parse_timeout_ms("invalid!!", 5000) == 5000


def test_format_cli_command_basic() -> None:
    assert format_cli_command("run") == "elizaos run"


def test_format_cli_command_full() -> None:
    result = format_cli_command("run", cli_name="otto", profile="dev", env="staging")
    assert result == "otto --profile dev --env staging run"


# ---------------------------------------------------------------------------
# Type tests
# ---------------------------------------------------------------------------


def test_cli_context_creation() -> None:
    ctx = CliContext(
        program_name="otto",
        version="2.0.0",
        description="Otto CLI",
        workspace_dir="/home/user/project",
    )
    assert ctx.program_name == "otto"
    assert ctx.version == "2.0.0"
    assert ctx.workspace_dir == "/home/user/project"


def test_progress_reporter() -> None:
    progress = ProgressReporter(total=10, message="Starting...")
    assert progress.fraction() == 0.0
    assert not progress.is_complete()
    assert progress.display() == "[0/10] Starting..."

    progress.advance("Step 1 done")
    assert progress.current == 1
    assert progress.display() == "[1/10] Step 1 done"

    progress.set(10, "Done!")
    assert progress.is_complete()
    assert progress.fraction() == 1.0


def test_progress_reporter_unknown_total() -> None:
    progress = ProgressReporter(total=0, message="Processing...")
    assert progress.fraction() is None
    assert not progress.is_complete()
    assert progress.display() == "[0] Processing..."

    progress.advance("Item processed")
    assert progress.display() == "[1] Item processed"


def test_common_command_options_default() -> None:
    opts = CommonCommandOptions()
    assert opts.json is False
    assert opts.verbose is False
    assert opts.quiet is False
    assert opts.force is False
    assert opts.dry_run is False


def test_plugin_constants() -> None:
    assert PLUGIN_NAME == "cli"
    assert DEFAULT_CLI_NAME == "elizaos"
    assert DEFAULT_CLI_VERSION == "1.0.0"
