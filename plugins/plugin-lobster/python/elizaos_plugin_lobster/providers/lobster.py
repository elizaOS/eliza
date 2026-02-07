"""Lobster provider for context injection."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from elizaos_plugin_lobster.service import LobsterService

logger = logging.getLogger(__name__)


LOBSTER_HELP = """
## Lobster Workflow Runtime

Lobster is available for running multi-step pipelines with approval checkpoints.

### Commands

- `lobster run <pipeline>` - Run a pipeline
- `lobster resume <token>` - Resume a paused pipeline

### Example

```
lobster run deploy-pipeline
```

When a pipeline reaches an approval step, you'll be prompted to approve or reject.
"""


@dataclass
class LobsterProvider:
    """Provider that supplies Lobster context."""

    name: str = "lobster"
    description: str = "Provides Lobster workflow runtime context"
    position: int = 100

    _service: LobsterService | None = None
    _available: bool | None = None

    async def get(
        self,
        message: dict[str, Any],
        state: dict[str, Any] | None = None,
        service: LobsterService | None = None,
    ) -> dict[str, Any]:
        """Get Lobster context for the agent."""
        if service:
            self._service = service

        if self._service is None:
            self._service = LobsterService()

        # Check availability if not cached
        if self._available is None:
            self._available = await self._service.is_available()

        if not self._available:
            return {
                "values": {"available": False},
                "text": "Lobster is not available. Install it to enable pipeline execution.",
                "data": {"available": False},
            }

        # Check for pending approval
        pending_token = (state or {}).get("pendingLobsterToken")

        if pending_token:
            return {
                "values": {"available": True, "pendingApproval": True},
                "text": (
                    "Lobster has a pending approval. "
                    "Reply with 'approve' or 'reject' to continue the pipeline."
                ),
                "data": {
                    "available": True,
                    "pendingApproval": True,
                    "resumeToken": pending_token,
                },
            }

        return {
            "values": {"available": True},
            "text": LOBSTER_HELP,
            "data": {"available": True},
        }
