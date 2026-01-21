"""
Auto-generated prompt templates
DO NOT EDIT - Generated from ../../../prompts/*.txt

These prompts use Handlebars-style template syntax:
- {{variableName}} for simple substitution
- {{#each items}}...{{/each}} for iteration
- {{#if condition}}...{{/if}} for conditionals
"""

from __future__ import annotations

GENERATE_DM_TEMPLATE = """Generate a friendly direct message response under 200 characters."""

GENERATE_POST_TEMPLATE = """Generate an engaging BlueSky post under {{maxLength}} characters."""

TRUNCATE_POST_TEMPLATE = """Shorten to under {{maxLength}} characters: "{{text}}""" ""

__all__ = [
    "GENERATE_DM_TEMPLATE",
    "GENERATE_POST_TEMPLATE",
    "TRUNCATE_POST_TEMPLATE",
]
