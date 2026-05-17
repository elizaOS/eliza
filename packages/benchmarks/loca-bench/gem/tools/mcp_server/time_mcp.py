# Copyright 2025 AxonRL Team. All Rights Reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Adapted from https://github.com/yokingma/time-mcp

import calendar
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

try:
    from zoneinfo import ZoneInfo  # Python 3.9+
except Exception:  # pragma: no cover
    ZoneInfo = None  # type: ignore

from fastmcp import FastMCP  # FastMCP 2.0 import

# Set up logger
logger = logging.getLogger(__name__)

app = FastMCP("mcp-time-server")

# Note: In this context the docstrings are meant for the client AI to understand the tools and their purpose.


# -----------------------------
# Helpers
# -----------------------------


def _local_tz():
    return datetime.now().astimezone().tzinfo


def _get_tz(tz_name: Optional[str]):
    if tz_name is None or tz_name == "":
        return _local_tz()
    if ZoneInfo is None:
        # Fallback: return local tz if zoneinfo is unavailable
        return _local_tz()
    try:
        return ZoneInfo(tz_name)
    except Exception:
        return _local_tz()


def _moment_to_strftime(fmt: str) -> str:
    """
    Convert a subset of Moment.js-like format tokens to Python strftime tokens.

    Supported inputs (from TS enum):
    - h:mm A
    - h:mm:ss A
    - YYYY-MM-DD HH:mm:ss
    - YYYY-MM-DD
    - YYYY-MM
    - MM/DD/YYYY
    - MM/DD/YY
    - YYYY/MM/DD
    - YYYY/MM
    """
    # Map carefully to avoid partial replacements interfering with each other
    replacements = [
        ("YYYY", "%Y"),
        ("YY", "%y"),
        ("HH", "%H"),  # 24-hour
        ("mm", "%M"),
        ("ss", "%S"),
        ("MM", "%m"),
        ("DD", "%d"),
        ("A", "%p"),  # AM/PM
    ]

    # 'h' (12-hour no leading zero) → '%-I' on POSIX; fallback to '%I'
    # We'll choose '%-I' for Linux as per the environment; if unsupported at runtime, '%I' will still work but may show leading zero.
    fmt = fmt.replace("h", "%-I")

    for src, dst in replacements:
        fmt = fmt.replace(src, dst)

    return fmt


def _parse_dt(time_str: str) -> datetime:
    """Parse 'YYYY-MM-DD HH:mm:ss' or 'YYYY-MM-DD HH:mm:ss.SSS' as naive local datetime."""
    if "." in time_str:
        # with milliseconds
        # normalize to microseconds if needed
        main, frac = time_str.split(".", 1)
        frac = (frac + "000000")[:6]
        dt = datetime.strptime(f"{main}.{frac}", "%Y-%m-%d %H:%M:%S.%f")
    else:
        dt = datetime.strptime(time_str, "%Y-%m-%d %H:%M:%S")
    # Attach local timezone
    return dt.replace(tzinfo=_local_tz())


def _parse_date(date_str: str) -> datetime:
    """Parse 'YYYY-MM-DD' as naive local date at 00:00:00."""
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    return dt.replace(tzinfo=_local_tz())


# -----------------------------
# Tools
# -----------------------------


@app.tool(
    annotations={
        "title": "Get current date/time in optional timezone",
        "readOnlyHint": True,
    }
)
def current_time(
    format: str = "YYYY-MM-DD HH:mm:ss", timezone: Optional[str] = None
) -> str:
    """
    Return the current date/time using a limited set of Moment.js-like formats and optional IANA timezone.

    - format: One of [h:mm A, h:mm:ss A, YYYY-MM-DD HH:mm:ss, YYYY-MM-DD, YYYY-MM, MM/DD/YYYY, MM/DD/YY, YYYY/MM/DD, YYYY/MM]
    - timezone: IANA timezone (e.g., Asia/Shanghai). If omitted, use local timezone.
    """
    tz = _get_tz(timezone)
    now = datetime.now(tz=tz)
    py_fmt = _moment_to_strftime(format)
    try:
        return now.strftime(py_fmt)
    except Exception:
        # Fallback to default format if formatting fails
        return now.strftime("%Y-%m-%d %H:%M:%S")


@app.tool(
    annotations={
        "title": "Relative time from now",
        "readOnlyHint": True,
    }
)
def relative_time(time: str) -> str:
    """
    Get the relative time from now for a timestamp formatted as 'YYYY-MM-DD HH:mm:ss'.

    - time: e.g. 2025-03-23 12:30:00
    """
    target = _parse_dt(time)
    now = datetime.now(tz=_local_tz())
    delta: timedelta = target - now

    seconds = int(delta.total_seconds())
    future = seconds > 0
    seconds = abs(seconds)

    def _fmt(value: int, unit: str) -> str:
        return f"in {value} {unit}" if future else f"{value} {unit} ago"

    if seconds < 60:
        return _fmt(seconds, "seconds")
    minutes = seconds // 60
    if minutes < 60:
        return _fmt(minutes, "minutes")
    hours = minutes // 60
    if hours < 24:
        return _fmt(hours, "hours")
    days = hours // 24
    if days < 30:
        return _fmt(days, "days")
    months = days // 30
    if months < 12:
        return _fmt(months, "months")
    years = months // 12
    return _fmt(years, "years")


@app.tool(
    annotations={
        "title": "Days in month",
        "readOnlyHint": True,
    }
)
def days_in_month(date: Optional[str] = None) -> str:
    """
    Get the number of days in a month. If no date is provided, use the current month.

    - date: 'YYYY-MM-DD'
    """
    if date:
        dt = _parse_date(date)
    else:
        dt = datetime.now(tz=_local_tz())
    days = calendar.monthrange(dt.year, dt.month)[1]
    return str(days)


@app.tool(
    annotations={
        "title": "Get Unix timestamp (ms)",
        "readOnlyHint": True,
    }
)
def get_timestamp(time: str) -> str:
    """
    Get the Unix timestamp in milliseconds for a time formatted as 'YYYY-MM-DD HH:mm:ss.SSS'.

    - time: e.g. 2025-03-23 12:30:00.000
    """
    dt = _parse_dt(time)
    # Convert to UTC and compute epoch milliseconds
    epoch_ms = int(dt.astimezone(timezone.utc).timestamp() * 1000)
    return str(epoch_ms)


@app.tool(
    annotations={
        "title": "Convert time between timezones",
        "readOnlyHint": True,
    }
)
def convert_time(sourceTimezone: str, targetTimezone: str, time: str) -> str:
    """
    Convert 'YYYY-MM-DD HH:mm:ss' from source timezone to target timezone.

    - sourceTimezone: IANA timezone (e.g., Asia/Shanghai)
    - targetTimezone: IANA timezone (e.g., Europe/London)
    - time: e.g. 2025-03-23 12:30:00
    """
    src_tz = _get_tz(sourceTimezone)
    tgt_tz = _get_tz(targetTimezone)
    # Parse naive then attach source tz directly (interpretation), not convert from local
    if "." in time:
        main, frac = time.split(".", 1)
        frac = (frac + "000000")[:6]
        naive = datetime.strptime(f"{main}.{frac}", "%Y-%m-%d %H:%M:%S.%f")
    else:
        naive = datetime.strptime(time, "%Y-%m-%d %H:%M:%S")
    src_dt = naive.replace(tzinfo=src_tz)
    tgt_dt = src_dt.astimezone(tgt_tz)
    return tgt_dt.strftime("%Y-%m-%d %H:%M:%S")


@app.tool(
    annotations={
        "title": "Get week number and ISO week number",
        "readOnlyHint": True,
    }
)
def get_week_year(date: Optional[str] = None) -> str:
    """
    Get the week number and ISO week number of a given date.

    - date: 'YYYY-MM-DD'. If omitted, use today.
    Returns: 'week: <W>, isoWeek: <ISO_W>'
    """
    if date:
        dt = _parse_date(date)
    else:
        dt = datetime.now(tz=_local_tz())

    # %W: Week number of the year (Monday as the first day of the week) as a decimal number.
    # ISO week from isocalendar()
    week_mon = int(dt.strftime("%W"))
    iso_week = dt.isocalendar().week
    return f"week: {week_mon}, isoWeek: {iso_week}"


if __name__ == "__main__":
    import argparse

    # Parse command line arguments for transport selection
    parser = argparse.ArgumentParser(description="Time MCP Server")
    parser.add_argument(
        "--transport",
        choices=["stdio", "http", "streamable-http"],
        default="streamable-http",
        help="Transport protocol to use (default: streamable-http)",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Host to bind to for HTTP transport (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8081,
        help="Port to bind to for HTTP transport (default: 8081)",
    )
    parser.add_argument(
        "--path",
        default="/time-mcp",
        help="Path for HTTP endpoint (default: /time-mcp)",
    )
    parser.add_argument(
        "--log-level",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        default="INFO",
        help="Log level (default: INFO)",
    )

    args = parser.parse_args()

    # Configure logging based on the specified log level
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper()),
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )

    # Run the server with the specified transport
    if args.transport in ["http", "streamable-http"]:
        logger.info("Starting Time MCP Server with Streamable HTTP transport")
        logger.info(
            f"Server will be available at: http://{args.host}:{args.port}{args.path}"
        )
        logger.info(f"Log level: {args.log_level}")
        logger.info("Press Ctrl+C to stop the server")
        app.run(
            transport="streamable-http",
            host=args.host,
            port=args.port,
            path=args.path,
            log_level=args.log_level.lower(),
        )
    else:
        # Default stdio transport
        logger.info("Starting Time MCP Server with stdio transport")
        app.run(transport="stdio")
