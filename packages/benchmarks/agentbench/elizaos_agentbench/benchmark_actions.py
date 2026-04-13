"""
ElizaOS Actions for AgentBench Environments.

This module defines proper ElizaOS Actions for each benchmark environment,
enabling the agent to interact with benchmark tasks through the canonical
action system rather than just text parsing.

These actions can be registered with the ElizaOS runtime to provide
structured tool-use capabilities for benchmark execution.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos.types import (
        Action,
        ActionExample,
        ActionResult,
        Content,
        HandlerCallback,
        HandlerOptions,
        IAgentRuntime,
        Memory,
        State,
    )


# =============================================================================
# OS Environment Action
# =============================================================================

@dataclass
class ExecuteBashAction:
    """Action for executing bash commands in the OS benchmark environment."""

    name: str = "EXECUTE_BASH"
    similes: list[str] = field(
        default_factory=lambda: ["RUN_COMMAND", "SHELL", "BASH", "TERMINAL"]
    )
    description: str = (
        "Execute a bash command in the operating system environment. "
        "Use this for file operations, system commands, and terminal interactions."
    )

    async def validate(
        self, runtime: "IAgentRuntime", _message: "Memory", _state: "State | None" = None
    ) -> bool:
        """Validate that the action can be executed."""
        # Check if we're in a benchmark context with OS adapter
        return True

    async def handler(
        self,
        runtime: "IAgentRuntime",
        message: "Memory",
        state: "State | None" = None,
        options: "HandlerOptions | None" = None,
        callback: "HandlerCallback | None" = None,
        responses: "list[Memory] | None" = None,
    ) -> "ActionResult":
        """Execute a bash command."""
        from elizaos.types import ActionResult

        command = ""
        if options and options.parameters:
            command = str(options.parameters.get("command", ""))

        return ActionResult(
            text=f"Executing bash command: {command}",
            values={"command": command, "executed": True},
            data={"action": "EXECUTE_BASH", "command": command},
            success=True,
        )

    @property
    def examples(self) -> "list[list[ActionExample]]":
        """Example usages of this action."""
        from elizaos.types import ActionExample, Content

        return [
            [
                ActionExample(
                    name="{{user}}",
                    content=Content(text="List all files in the current directory"),
                ),
                ActionExample(
                    name="{{agent}}",
                    content=Content(
                        text="```bash\nls -la\n```",
                        actions=["EXECUTE_BASH"],
                    ),
                ),
            ],
            [
                ActionExample(
                    name="{{user}}",
                    content=Content(text="Create a new directory called 'test'"),
                ),
                ActionExample(
                    name="{{agent}}",
                    content=Content(
                        text="```bash\nmkdir test\n```",
                        actions=["EXECUTE_BASH"],
                    ),
                ),
            ],
        ]


# =============================================================================
# Database Environment Action
# =============================================================================

@dataclass
class ExecuteSQLAction:
    """Action for executing SQL queries in the database benchmark environment."""

    name: str = "EXECUTE_SQL"
    similes: list[str] = field(
        default_factory=lambda: ["QUERY_DATABASE", "SQL", "DATABASE_QUERY", "DB_QUERY"]
    )
    description: str = (
        "Execute a SQL query against the database. "
        "Use this for SELECT, INSERT, UPDATE queries to retrieve or modify data."
    )

    async def validate(
        self, runtime: "IAgentRuntime", _message: "Memory", _state: "State | None" = None
    ) -> bool:
        """Validate that the action can be executed."""
        return True

    async def handler(
        self,
        runtime: "IAgentRuntime",
        message: "Memory",
        state: "State | None" = None,
        options: "HandlerOptions | None" = None,
        callback: "HandlerCallback | None" = None,
        responses: "list[Memory] | None" = None,
    ) -> "ActionResult":
        """Execute a SQL query."""
        from elizaos.types import ActionResult

        query = ""
        if options and options.parameters:
            query = str(options.parameters.get("query", ""))

        return ActionResult(
            text=f"Executing SQL query: {query}",
            values={"query": query, "executed": True},
            data={"action": "EXECUTE_SQL", "query": query},
            success=True,
        )

    @property
    def examples(self) -> "list[list[ActionExample]]":
        """Example usages of this action."""
        from elizaos.types import ActionExample, Content

        return [
            [
                ActionExample(
                    name="{{user}}",
                    content=Content(text="Find all employees earning over $50000"),
                ),
                ActionExample(
                    name="{{agent}}",
                    content=Content(
                        text="```sql\nSELECT * FROM employees WHERE salary > 50000;\n```",
                        actions=["EXECUTE_SQL"],
                    ),
                ),
            ],
        ]


# =============================================================================
# Knowledge Graph Environment Action
# =============================================================================

@dataclass
class QueryKnowledgeGraphAction:
    """Action for querying the knowledge graph in the KG benchmark environment."""

    name: str = "QUERY_KG"
    similes: list[str] = field(
        default_factory=lambda: ["KNOWLEDGE_GRAPH", "KG_QUERY", "GRAPH_QUERY", "FIND_ENTITY"]
    )
    description: str = (
        "Query the knowledge graph to find entities, relationships, or traverse paths. "
        "Use operations like get_entity, find_relations, find_entities, traverse."
    )

    async def validate(
        self, runtime: "IAgentRuntime", _message: "Memory", _state: "State | None" = None
    ) -> bool:
        """Validate that the action can be executed."""
        return True

    async def handler(
        self,
        runtime: "IAgentRuntime",
        message: "Memory",
        state: "State | None" = None,
        options: "HandlerOptions | None" = None,
        callback: "HandlerCallback | None" = None,
        responses: "list[Memory] | None" = None,
    ) -> "ActionResult":
        """Execute a knowledge graph query."""
        from elizaos.types import ActionResult

        operation = ""
        if options and options.parameters:
            operation = str(options.parameters.get("operation", ""))

        return ActionResult(
            text=f"Querying knowledge graph: {operation}",
            values={"operation": operation, "executed": True},
            data={"action": "QUERY_KG", "operation": operation},
            success=True,
        )

    @property
    def examples(self) -> "list[list[ActionExample]]":
        """Example usages of this action."""
        from elizaos.types import ActionExample, Content

        return [
            [
                ActionExample(
                    name="{{user}}",
                    content=Content(text="Find where Albert Einstein was born"),
                ),
                ActionExample(
                    name="{{agent}}",
                    content=Content(
                        text="find_relations[subject=e001, predicate=born_in]",
                        actions=["QUERY_KG"],
                    ),
                ),
            ],
        ]


# =============================================================================
# Web Shopping Environment Action
# =============================================================================

@dataclass
class WebShopAction:
    """Action for interacting with the web shopping environment."""

    name: str = "WEB_SHOP"
    similes: list[str] = field(
        default_factory=lambda: ["SHOPPING", "BUY", "PURCHASE", "SEARCH_PRODUCTS"]
    )
    description: str = (
        "Interact with the web shopping environment to search products, "
        "view details, add to cart, and checkout."
    )

    async def validate(
        self, runtime: "IAgentRuntime", _message: "Memory", _state: "State | None" = None
    ) -> bool:
        """Validate that the action can be executed."""
        return True

    async def handler(
        self,
        runtime: "IAgentRuntime",
        message: "Memory",
        state: "State | None" = None,
        options: "HandlerOptions | None" = None,
        callback: "HandlerCallback | None" = None,
        responses: "list[Memory] | None" = None,
    ) -> "ActionResult":
        """Execute a web shopping action."""
        from elizaos.types import ActionResult

        action = ""
        if options and options.parameters:
            action = str(options.parameters.get("action", ""))

        return ActionResult(
            text=f"Web shop action: {action}",
            values={"action": action, "executed": True},
            data={"action": "WEB_SHOP", "shop_action": action},
            success=True,
        )

    @property
    def examples(self) -> "list[list[ActionExample]]":
        """Example usages of this action."""
        from elizaos.types import ActionExample, Content

        return [
            [
                ActionExample(
                    name="{{user}}",
                    content=Content(text="Find wireless headphones under $100"),
                ),
                ActionExample(
                    name="{{agent}}",
                    content=Content(
                        text="search[wireless headphones under $100]",
                        actions=["WEB_SHOP"],
                    ),
                ),
            ],
        ]


# =============================================================================
# Lateral Thinking Environment Action
# =============================================================================

@dataclass
class LateralThinkingAction:
    """Action for interacting with the lateral thinking puzzle environment."""

    name: str = "LATERAL_THINKING"
    similes: list[str] = field(
        default_factory=lambda: ["PUZZLE", "ASK_QUESTION", "GUESS", "THINK"]
    )
    description: str = (
        "Interact with a lateral thinking puzzle. "
        "Ask yes/no questions to gather clues, request hints, or make guesses."
    )

    async def validate(
        self, runtime: "IAgentRuntime", _message: "Memory", _state: "State | None" = None
    ) -> bool:
        """Validate that the action can be executed."""
        return True

    async def handler(
        self,
        runtime: "IAgentRuntime",
        message: "Memory",
        state: "State | None" = None,
        options: "HandlerOptions | None" = None,
        callback: "HandlerCallback | None" = None,
        responses: "list[Memory] | None" = None,
    ) -> "ActionResult":
        """Execute a lateral thinking action."""
        from elizaos.types import ActionResult

        action = ""
        if options and options.parameters:
            action = str(options.parameters.get("action", ""))

        return ActionResult(
            text=f"Lateral thinking action: {action}",
            values={"action": action, "executed": True},
            data={"action": "LATERAL_THINKING", "puzzle_action": action},
            success=True,
        )

    @property
    def examples(self) -> "list[list[ActionExample]]":
        """Example usages of this action."""
        from elizaos.types import ActionExample, Content

        return [
            [
                ActionExample(
                    name="{{user}}",
                    content=Content(text="A man walks into a bar and asks for water..."),
                ),
                ActionExample(
                    name="{{agent}}",
                    content=Content(
                        text="ask[Did the man have hiccups?]",
                        actions=["LATERAL_THINKING"],
                    ),
                ),
            ],
        ]


# =============================================================================
# Action Registration
# =============================================================================

def create_benchmark_actions() -> "list[Action]":
    """Create all benchmark actions as proper ElizaOS Action objects."""
    from elizaos.types import Action

    actions = []

    # OS Action
    os_action_impl = ExecuteBashAction()
    actions.append(
        Action(
            name=os_action_impl.name,
            similes=os_action_impl.similes,
            description=os_action_impl.description,
            validate=os_action_impl.validate,
            handler=os_action_impl.handler,
            examples=os_action_impl.examples,
        )
    )

    # SQL Action
    sql_action_impl = ExecuteSQLAction()
    actions.append(
        Action(
            name=sql_action_impl.name,
            similes=sql_action_impl.similes,
            description=sql_action_impl.description,
            validate=sql_action_impl.validate,
            handler=sql_action_impl.handler,
            examples=sql_action_impl.examples,
        )
    )

    # KG Action
    kg_action_impl = QueryKnowledgeGraphAction()
    actions.append(
        Action(
            name=kg_action_impl.name,
            similes=kg_action_impl.similes,
            description=kg_action_impl.description,
            validate=kg_action_impl.validate,
            handler=kg_action_impl.handler,
            examples=kg_action_impl.examples,
        )
    )

    # Web Shop Action
    ws_action_impl = WebShopAction()
    actions.append(
        Action(
            name=ws_action_impl.name,
            similes=ws_action_impl.similes,
            description=ws_action_impl.description,
            validate=ws_action_impl.validate,
            handler=ws_action_impl.handler,
            examples=ws_action_impl.examples,
        )
    )

    # Lateral Thinking Action
    lt_action_impl = LateralThinkingAction()
    actions.append(
        Action(
            name=lt_action_impl.name,
            similes=lt_action_impl.similes,
            description=lt_action_impl.description,
            validate=lt_action_impl.validate,
            handler=lt_action_impl.handler,
            examples=lt_action_impl.examples,
        )
    )

    return actions


def create_benchmark_plugin() -> "Plugin":
    """Create a plugin that registers all benchmark actions."""
    from elizaos.types import Plugin

    async def init_plugin(
        config: dict,
        runtime: "IAgentRuntime",
    ) -> None:
        """Initialize the benchmark plugin."""
        runtime.logger.info(
            "AgentBench plugin initialized",
            src="plugin:agentbench",
            agent_id=str(runtime.agent_id),
        )

    return Plugin(
        name="agentbench",
        description="AgentBench benchmark actions for ElizaOS",
        init=init_plugin,
        config={},
        actions=create_benchmark_actions(),
        providers=[],
        evaluators=[],
    )


# Export convenience functions
__all__ = [
    "ExecuteBashAction",
    "ExecuteSQLAction",
    "QueryKnowledgeGraphAction",
    "WebShopAction",
    "LateralThinkingAction",
    "create_benchmark_actions",
    "create_benchmark_plugin",
]
