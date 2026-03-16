from elizaos_plugin_gmail_watch.config import GmailWatchConfig, ServeConfig
from elizaos_plugin_gmail_watch.error import (
    ConfigError,
    GmailWatchError,
    GogBinaryNotFoundError,
    ProcessError,
    RenewalError,
)
from elizaos_plugin_gmail_watch.service import GmailWatchService

__all__ = [
    "GmailWatchConfig",
    "ServeConfig",
    "GmailWatchError",
    "ConfigError",
    "GogBinaryNotFoundError",
    "ProcessError",
    "RenewalError",
    "GmailWatchService",
]

__version__ = "2.0.0"
PLUGIN_NAME = "gmail-watch"
PLUGIN_DESCRIPTION = "Gmail Pub/Sub push watcher – spawns gog gmail watch serve"
