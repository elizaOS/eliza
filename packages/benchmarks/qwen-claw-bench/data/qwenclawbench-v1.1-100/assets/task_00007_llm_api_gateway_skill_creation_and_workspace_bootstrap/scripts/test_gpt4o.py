#!/usr/bin/env python3
"""
Test script for GPT-4o API connectivity.
Usage: python3 test_gpt4o.py --base-url <url> --api-key <key>
"""

import argparse
import json
import urllib.request
import urllib.error
import sys


def test_connection(base_url: str, api_key: str, model: str = "gpt-4o"):
    """Send a simple test request to verify API connectivity."""
    url = f"{base_url.rstrip('/')}/v1/chat/completions"
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": "Say hello in one word."}],
        "max_tokens": 10,
    }).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            content = data["choices"][0]["message"]["content"]
            print(f"✅ Success! Model responded: {content}")
            print(f"   Model: {data.get('model', 'unknown')}")
            usage = data.get("usage", {})
            print(f"   Tokens: {usage.get('prompt_tokens', '?')} prompt, "
                  f"{usage.get('completion_tokens', '?')} completion")
            return True
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"❌ HTTP {e.code}: {body}", file=sys.stderr)
        return False
    except Exception as e:
        print(f"❌ Connection error: {e}", file=sys.stderr)
        return False


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Test GPT-4o API connectivity")
    parser.add_argument("--base-url", required=True, help="API base URL")
    parser.add_argument("--api-key", required=True, help="API key")
    parser.add_argument("--model", default="gpt-4o", help="Model name")
    args = parser.parse_args()

    success = test_connection(args.base_url, args.api_key, args.model)
    sys.exit(0 if success else 1)
