"""AI Browser - Intelligent web content extraction and cleaning tool."""

__version__ = "0.4.2"
__author__ = "AI Browser Team"

from .core import AIBrowser
from .cleaner import ContentCleaner
from .injector import ScriptInjector
from .template_engine import TemplateEngine

__all__ = ["AIBrowser", "ContentCleaner", "ScriptInjector", "TemplateEngine"]
