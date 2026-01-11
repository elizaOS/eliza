"""
Action module exports.
"""

from elizaos_browser.actions.navigate import browser_navigate
from elizaos_browser.actions.click import browser_click
from elizaos_browser.actions.type import browser_type
from elizaos_browser.actions.select import browser_select
from elizaos_browser.actions.extract import browser_extract
from elizaos_browser.actions.screenshot import browser_screenshot

__all__ = [
    "browser_navigate",
    "browser_click",
    "browser_type",
    "browser_select",
    "browser_extract",
    "browser_screenshot",
]


