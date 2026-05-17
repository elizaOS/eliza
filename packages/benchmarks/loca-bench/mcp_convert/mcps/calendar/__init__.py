"""
Simplified Calendar MCP Server

Provides Google Calendar-like functionality using local JSON files.
"""

from .database_utils import CalendarDatabase
from .server import CalendarMCPServer

__all__ = ['CalendarDatabase', 'CalendarMCPServer']

