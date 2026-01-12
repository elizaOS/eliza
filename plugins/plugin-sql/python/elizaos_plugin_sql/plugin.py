from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Plugin

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime


async def init_sql_plugin(
    config: dict[str, str | int | float | bool | None], runtime: IAgentRuntime
) -> None:
    _ = config, runtime


sql_plugin = Plugin(
    name="@elizaos/plugin-sql",
    description="PostgreSQL and PGLite database adapters for elizaOS",
    init=init_sql_plugin,
    config={
        "database_url": None,
        "pool_size": 5,
        "max_overflow": 10,
    },
)
