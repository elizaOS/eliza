#!/usr/bin/env python3

import argparse
import socket
import sys
import time
from typing import Optional


RESP_PING = b"*1\r\n$4\r\nPING\r\n"


def ping_redis(host: str, port: int, timeout: float) -> bool:
    with socket.create_connection((host, port), timeout=timeout) as sock:
        sock.sendall(RESP_PING)
        response = sock.recv(16)
    return response.startswith(b"+PONG")


def wait_for_redis(
    host: str,
    port: int,
    total_timeout: float,
    interval: float,
) -> bool:
    attempt = 1
    deadline = time.monotonic() + total_timeout
    last_error: Optional[BaseException] = None

    while time.monotonic() < deadline:
        try:
            if ping_redis(host, port, timeout=interval):
                print(f"✅ Redis is ready (attempt {attempt})")
                return True
        except BaseException as exc:  # pragma: no cover - defensive
            last_error = exc
        attempt += 1
        time.sleep(interval)

    print(f"❌ Redis did not become ready within {total_timeout:.0f} seconds")
    if last_error is not None:
        print(f"Last error: {last_error}")
    return False


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Wait for Redis PING/PONG readiness.")
    parser.add_argument("--host", default="localhost", help="Redis host (default: localhost)")
    parser.add_argument("--port", type=int, default=6379, help="Redis port (default: 6379)")
    parser.add_argument(
        "--timeout",
        type=float,
        default=30.0,
        help="Total time to wait in seconds (default: 30)",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=1.0,
        help="Seconds to wait between attempts (default: 1)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    try:
        is_ready = wait_for_redis(
            host=args.host,
            port=args.port,
            total_timeout=args.timeout,
            interval=args.interval,
        )
    except KeyboardInterrupt:  # pragma: no cover - handled gracefully
        print("⚠️ Redis readiness check interrupted")
        return 1

    return 0 if is_ready else 1


if __name__ == "__main__":
    sys.exit(main())

