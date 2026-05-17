"""
GAIA Benchmark Tools

Tools required for GAIA benchmark tasks including web search, web browsing,
file processing, code execution, and calculations.
"""

from elizaos_gaia.tools.calculator import Calculator
from elizaos_gaia.tools.code_executor import CodeExecutor

__all__ = [
    "WebSearchTool",
    "WebBrowserTool",
    "FileProcessor",
    "CodeExecutor",
    "Calculator",
]


def __getattr__(name: str) -> object:
    if name == "FileProcessor":
        from elizaos_gaia.tools.file_processor import FileProcessor

        return FileProcessor
    if name == "WebBrowserTool":
        from elizaos_gaia.tools.web_browser import WebBrowserTool

        return WebBrowserTool
    if name == "WebSearchTool":
        from elizaos_gaia.tools.web_search import WebSearchTool

        return WebSearchTool
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
