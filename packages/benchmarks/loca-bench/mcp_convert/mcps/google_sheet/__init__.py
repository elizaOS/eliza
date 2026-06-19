"""
Google Sheets MCP Server

A Model Context Protocol server that provides Google Sheets functionality
using local JSON files as the database instead of connecting to external APIs.
"""

__version__ = "1.0.0"
__author__ = "MCP Bench Project"

from .server import GoogleSheetMCPServer
from .database_utils import GoogleSheetDatabase

__all__ = ["GoogleSheetMCPServer", "GoogleSheetDatabase"]





