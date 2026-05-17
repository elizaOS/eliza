"""
Logging configuration for MCP servers.

Import this module at the top of MCP server files to suppress verbose logging
when LOCA_QUIET environment variable is set.
"""

import logging
import os

def configure_quiet_logging():
    """Configure logging to be quiet when LOCA_QUIET is set."""
    if os.environ.get('LOCA_QUIET', '').lower() in ('1', 'true', 'yes'):
        logging.basicConfig(level=logging.WARNING, force=True)
        logging.getLogger().setLevel(logging.WARNING)
        for logger_name in ["mcp", "fastmcp", "mcp.server", "mcp.client", "httpx", "asyncio"]:
            logging.getLogger(logger_name).setLevel(logging.WARNING)

# Auto-configure on import
configure_quiet_logging()
