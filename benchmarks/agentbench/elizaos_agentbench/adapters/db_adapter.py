"""
Database environment adapter for AgentBench.

This adapter handles SQL query generation and execution tasks.
"""

import logging
import os
import re
import sqlite3
import tempfile

from elizaos_agentbench.types import (
    AgentBenchEnvironment,
    AgentRuntimeProtocol,
    AgentBenchTask,
    EnvironmentConfig,
    ObservationType,
)
from elizaos_agentbench.adapters.base import EnvironmentAdapter

logger = logging.getLogger(__name__)

# Type alias for step info
StepInfoType = dict[str, str | int | float | bool | None]

# Type for schema storage - includes bool fields like primary_key
SchemaColumnType = dict[str, str | bool]


class DatabaseEnvironmentAdapter(EnvironmentAdapter):
    """
    Adapter for Database (SQL) environment.

    Tasks include query composition, data retrieval, and schema understanding.
    """

    environment = AgentBenchEnvironment.DATABASE

    # SQL keywords that are not allowed in table/column names
    SQL_RESERVED_WORDS: set[str] = {
        "SELECT", "INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER",
        "TABLE", "DATABASE", "INDEX", "FROM", "WHERE", "AND", "OR", "NOT",
    }

    def __init__(
        self,
        runtime: AgentRuntimeProtocol | None = None,
        config: EnvironmentConfig | None = None,
    ) -> None:
        super().__init__(runtime, config)
        self._connection: sqlite3.Connection | None = None
        self._db_path: str | None = None
        self._schema: dict[str, list[SchemaColumnType]] = {}
        self._query_history: list[str] = []
        self._max_results = 100

    async def initialize(self) -> None:
        """Initialize database connection."""
        if self._initialized:
            return

        logger.info("[DB] Initializing Database environment adapter...")

        # Create temporary database file
        fd, self._db_path = tempfile.mkstemp(suffix=".db", prefix="agentbench_db_")
        os.close(fd)
        self._connection = sqlite3.connect(self._db_path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row

        self._initialized = True
        logger.info("[DB] Database environment adapter initialized")

    def _validate_sql_identifier(self, name: str, identifier_type: str) -> None:
        """Validate that a name is safe for use as SQL identifier."""
        if not name:
            raise ValueError(f"{identifier_type} name cannot be empty")
        if not re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*$", name):
            raise ValueError(f"Invalid {identifier_type} name: {name}")
        if name.upper() in self.SQL_RESERVED_WORDS:
            raise ValueError(f"{identifier_type} name cannot be a SQL reserved word: {name}")

    async def reset(self, task: AgentBenchTask) -> ObservationType:
        """Reset database for a new task."""
        self._query_history = []
        self._schema = {}

        # Drop all existing tables
        cursor = self._connection.cursor() if self._connection else None
        if cursor:
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
            tables = [row[0] for row in cursor.fetchall()]
            for table in tables:
                # Validate table name before dropping (paranoid check)
                if re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*$", table):
                    cursor.execute(f"DROP TABLE IF EXISTS [{table}]")
            if self._connection:
                self._connection.commit()

        # Create schema from task initial state
        schema_definition = task.initial_state.get("schema")
        data = task.initial_state.get("data")

        if isinstance(schema_definition, dict):
            for table_name, columns in schema_definition.items():
                # Validate table name to prevent SQL injection
                self._validate_sql_identifier(table_name, "table")

                if not isinstance(columns, list):
                    continue

                column_defs: list[str] = []
                schema_columns: list[SchemaColumnType] = []

                for col in columns:
                    if not isinstance(col, dict):
                        continue
                    col_name = col.get("name", "")
                    col_type = col.get("type", "TEXT")

                    # Validate column name
                    self._validate_sql_identifier(col_name, "column")

                    col_def = f"[{col_name}] {col_type}"
                    if col.get("primary_key"):
                        col_def += " PRIMARY KEY"
                    if col.get("not_null"):
                        col_def += " NOT NULL"
                    column_defs.append(col_def)
                    schema_columns.append({
                        "name": col_name,
                        "type": col_type,
                        "primary_key": bool(col.get("primary_key")),
                        "not_null": bool(col.get("not_null")),
                    })

                if column_defs and cursor:
                    create_sql = f"CREATE TABLE [{table_name}] ({', '.join(column_defs)})"
                    cursor.execute(create_sql)
                    self._schema[table_name] = schema_columns

        # Insert initial data using parameterized queries
        if isinstance(data, dict):
            for table_name, rows in data.items():
                if not isinstance(rows, list) or not rows:
                    continue
                if table_name not in self._schema:
                    continue  # Only insert into tables we created

                first_row = rows[0]
                if not isinstance(first_row, dict):
                    continue

                columns = list(first_row.keys())
                # Validate column names
                for col in columns:
                    self._validate_sql_identifier(col, "column")

                placeholders = ", ".join(["?" for _ in columns])
                col_names = ", ".join([f"[{col}]" for col in columns])
                insert_sql = f"INSERT INTO [{table_name}] ({col_names}) VALUES ({placeholders})"

                if cursor:
                    for row in rows:
                        if isinstance(row, dict):
                            values = [row.get(col) for col in columns]
                            cursor.execute(insert_sql, values)

        if self._connection:
            self._connection.commit()

        return {
            "schema": self._format_schema(),
            "task_description": task.description,
            "goal": task.goal,
            "tables": list(self._schema.keys()),
        }

    async def step(self, action: str) -> tuple[ObservationType, float, bool, StepInfoType]:
        """Execute SQL query and return result."""
        query = self._extract_query(action)

        if not query:
            return (
                {"error": "No valid SQL query found in action"},
                -0.1,
                False,
                {"action": action},
            )

        # Check for dangerous operations BEFORE adding to history
        query_upper = query.upper().strip()
        dangerous_ops = [
            "DROP DATABASE",
            "TRUNCATE",
            "ALTER TABLE",
            "DROP TABLE",
            "ATTACH",
            "DETACH",
            "PRAGMA",
            "VACUUM",
        ]
        if any(op in query_upper for op in dangerous_ops):
            return (
                {"error": "Operation not allowed", "query": query},
                -0.5,
                False,
                {"query": query, "blocked": True},
            )

        self._query_history.append(query)

        try:
            cursor = self._connection.cursor() if self._connection else None
            if not cursor:
                return (
                    {"error": "Database not initialized"},
                    -0.5,
                    False,
                    {"query": query},
                )

            cursor.execute(query)

            # Handle different query types
            columns: list[str] = []
            results: list[dict[str, str | int | float | bool | None]] = []

            if query_upper.startswith("SELECT"):
                rows = cursor.fetchmany(self._max_results)
                columns = [desc[0] for desc in cursor.description] if cursor.description else []
                results = [dict(zip(columns, row)) for row in rows]
                row_count = len(results)
            else:
                if self._connection:
                    self._connection.commit()
                row_count = cursor.rowcount if cursor.rowcount >= 0 else 0

            reward = 0.1 if row_count > 0 else 0.0

            observation: ObservationType = {
                "query": query,
                "results": results[:20],  # Limit displayed results
                "row_count": row_count,
                "columns": columns,
                "success": True,
            }

            # Check if query matches expected pattern (simple heuristic)
            done = False

            return observation, reward, done, {"query": query, "row_count": row_count}

        except sqlite3.Error as e:
            return (
                {"error": str(e), "query": query},
                -0.1,
                False,
                {"query": query, "sql_error": str(e)},
            )
        except Exception as e:
            return (
                {"error": str(e), "query": query},
                -0.2,
                False,
                {"query": query, "exception": str(e)},
            )

    def _extract_query(self, action: str) -> str:
        """Extract SQL query from action string."""
        patterns = [
            r"```sql\n(.*?)\n```",
            r"```\n(.*?)\n```",
            r"query:\s*(.+)",
            r"sql:\s*(.+)",
            r"execute:\s*(.+)",
        ]

        for pattern in patterns:
            match = re.search(pattern, action, re.DOTALL | re.IGNORECASE)
            if match:
                extracted = match.group(1).strip()
                return self._normalize_single_statement(extracted)

        # Check if it looks like SQL
        action = action.strip()
        sql_keywords = ["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP"]
        if any(action.upper().startswith(kw) for kw in sql_keywords):
            # Clean up common prefixes
            for prefix in ["Query:", "SQL:", "Execute:"]:
                if action.startswith(prefix):
                    action = action[len(prefix) :].strip()
            return self._normalize_single_statement(action)

        return ""

    def _normalize_single_statement(self, query: str) -> str:
        """
        Enforce a single-statement SQL query and normalize trailing semicolons.

        This prevents multi-statement injection and keeps evaluation predictable.
        """
        q = query.strip()
        if not q:
            return ""
        if "\x00" in q:
            return ""

        # Split on ';' and remove empty parts
        parts = [p.strip() for p in q.split(";") if p.strip()]
        if len(parts) != 1:
            return ""
        return parts[0]

    def _format_schema(self) -> str:
        """Format database schema as string."""
        schema_lines = []
        for table_name, columns in self._schema.items():
            col_strs = [
                f"  {col['name']} {col['type']}"
                + (" PRIMARY KEY" if col.get("primary_key") else "")
                for col in columns
            ]
            schema_lines.append(f"Table: {table_name}\n" + "\n".join(col_strs))
        return "\n\n".join(schema_lines)

    async def evaluate(self, task: AgentBenchTask, trajectory: list[str]) -> bool:
        """Evaluate if the SQL task was completed correctly."""
        if not task.ground_truth:
            return False

        # Execute expected query and compare results
        expected_query = task.ground_truth
        last_query = self._query_history[-1] if self._query_history else ""

        try:
            cursor = self._connection.cursor() if self._connection else None
            if not cursor:
                return False

            # Execute expected query
            cursor.execute(expected_query)
            expected_results = [tuple(row) for row in cursor.fetchall()]

            # Execute agent's last query
            if last_query:
                cursor.execute(last_query)
                actual_results = [tuple(row) for row in cursor.fetchall()]

                # Compare results
                if set(expected_results) == set(actual_results):
                    return True

            return False

        except Exception as e:
            logger.error(f"[DB] Evaluation error: {e}")
            return False

    async def cleanup(self) -> None:
        """Close database connection and cleanup."""
        if self._connection:
            self._connection.close()
            self._connection = None

        if self._db_path:
            try:
                os.unlink(self._db_path)
            except Exception as e:
                logger.error(f"[DB] Failed to cleanup database file: {e}")
            self._db_path = None

        self._initialized = False

    def get_action_space(self) -> list[str]:
        """Get available SQL operations."""
        return [
            "SELECT",
            "INSERT",
            "UPDATE",
            "DELETE",
            "CREATE TABLE",
            "JOIN",
            "WHERE",
            "GROUP BY",
            "ORDER BY",
            "HAVING",
            "LIMIT",
            "COUNT",
            "SUM",
            "AVG",
            "MAX",
            "MIN",
        ]

    def format_prompt(self, task: AgentBenchTask, observation: ObservationType) -> str:
        """Format observation into prompt for LLM."""
        last_query = observation.get("query", "")
        last_result = observation.get("results", [])
        error = observation.get("error", "")

        result_str = ""
        if isinstance(last_result, list) and last_result:
            result_str = f"\n**Last Query Results ({len(last_result)} rows):**\n"
            first_row = last_result[0]
            if isinstance(first_row, dict):
                cols = list(first_row.keys())
                result_str += " | ".join(cols) + "\n"
                result_str += " | ".join(["---"] * len(cols)) + "\n"
                for row in last_result[:10]:
                    if isinstance(row, dict):
                        result_str += " | ".join(str(row.get(c, "")) for c in cols) + "\n"
        elif error:
            result_str = f"\n**Error:** {error}\n"

        schema_str = observation.get('schema')
        if not isinstance(schema_str, str):
            schema_str = self._format_schema()

        return f"""You are an AI assistant that writes SQL queries. Your goal is to complete the following task.

**Task:** {task.description}
**Goal:** {task.goal}

**Database Schema:**
```
{schema_str}
```

{f"**Last Query:** `{last_query}`" if last_query else ""}
{result_str}

Please provide the SQL query to achieve the goal. Format your response as:
```sql
<your query here>
```

Think step by step about the query structure needed."""

    def parse_action(self, response: str) -> str:
        """Parse LLM response to extract SQL query."""
        return self._extract_query(response)
