#!/usr/bin/env python3
import argparse
import json
import resource
import subprocess
import sys
import tempfile
import time
import uuid

MARKER = "https://valhalla-app.xyz/release.json"


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def invalid_constant(value):
    raise ValueError(f"invalid JSON constant: {value}")


def verify(sha, request_id, attempts=18, delay=10):
    for attempt in range(attempts):
        url = f"{MARKER}?verify={uuid.uuid4().hex}"
        try:
            with tempfile.TemporaryFile() as output:
                subprocess.run(
                    ["curl", "--disable", "--silent", "--show-error", "--fail",
                     "--proto", "=https",
                     "--connect-timeout", "5", "--max-time", "10",
                     "--max-filesize", "65536", "--header", "Cache-Control: no-cache",
                     "--write-out", "\n%{http_code}", url],
                    check=True, stdout=output, stderr=subprocess.DEVNULL, timeout=12,
                    preexec_fn=lambda: resource.setrlimit(
                        resource.RLIMIT_FSIZE, (65540, 65540)),
                )
                output.seek(0)
                response = output.read(65541)
            data, separator, status = response.rpartition(b"\n")
            if not separator or status != b"200":
                raise ValueError("marker HTTP status is not 200")
            if len(data) > 65536:
                raise ValueError("marker too large")
            marker = json.loads(data, object_pairs_hook=unique_object,
                                parse_constant=invalid_constant)
            if (isinstance(marker, dict) and marker.get("sha") == sha
                    and marker.get("request_id") == request_id):
                return True
            raise ValueError("marker does not match")
        except (ValueError, UnicodeDecodeError, RecursionError,
                subprocess.SubprocessError, OSError) as exc:
            print(f"Marker verification attempt {attempt + 1} failed: {exc}", file=sys.stderr)
        if attempt + 1 < attempts:
            time.sleep(delay)
    return False


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--sha", required=True)
    parser.add_argument("--request-id", required=True)
    args = parser.parse_args()
    sys.exit(0 if verify(args.sha, args.request_id) else 1)
