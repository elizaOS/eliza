#!/usr/bin/env python3
"""Direct OpenAI test."""

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))


async def main():
    api_key = os.environ.get("OPENAI_API_KEY")
    print(f"API Key present: {bool(api_key)}")
    print(f"API Key length: {len(api_key) if api_key else 0}")

    if not api_key:
        print("No OPENAI_API_KEY found in environment!")
        return 1

    from elizaos_vending_bench.providers.openai import OpenAIProvider

    try:
        provider = OpenAIProvider(api_key=api_key, model="gpt-5-mini")

        response, tokens = await provider.generate(
            system_prompt="You are a helpful assistant.",
            user_prompt="Say 'Hello World' and nothing else.",
            temperature=0.0,
        )

        print(f"Response: {response}")
        print(f"Tokens: {tokens}")
        print("✅ OpenAI API working!")
        return 0
    except Exception as e:
        print(f"❌ Error: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
