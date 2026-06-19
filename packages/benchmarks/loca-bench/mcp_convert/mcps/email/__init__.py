"""
Simplified Email MCP Server

Provides Gmail-like functionality using local JSON files.
"""

from .database_utils import EmailDatabase
from .server import EmailMCPServer

__all__ = ['EmailDatabase', 'EmailMCPServer']

