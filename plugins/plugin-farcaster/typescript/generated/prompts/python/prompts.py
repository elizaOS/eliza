"""
Auto-generated prompt templates
DO NOT EDIT - Generated from ../../../../prompts/*.txt

These prompts use Handlebars-style template syntax:
- {{variableName}} for simple substitution
- {{#each items}}...{{/each}} for iteration
- {{#if condition}}...{{/if}} for conditionals
"""

from __future__ import annotations

REPLY_CAST_TEMPLATE = """Based on this request: "{{request}}", generate a helpful and engaging reply for a Farcaster cast (max 320 characters)."""

SEND_CAST_TEMPLATE = """Based on this request: "{{request}}", generate a concise Farcaster cast (max 320 characters). Be engaging and use appropriate hashtags if relevant."""

__all__ = [
    "REPLY_CAST_TEMPLATE",
    "SEND_CAST_TEMPLATE",
]
