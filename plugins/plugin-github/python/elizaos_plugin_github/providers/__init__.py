"""
GitHub Providers for elizaOS.

All available providers for the GitHub plugin.
"""

from elizaos_plugin_github.providers.repository_state import RepositoryStateProvider
from elizaos_plugin_github.providers.issue_context import IssueContextProvider

__all__ = [
    "RepositoryStateProvider",
    "IssueContextProvider",
]

# All providers list
all_providers = [
    RepositoryStateProvider(),
    IssueContextProvider(),
]

