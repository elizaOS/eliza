# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

import ast
import re
from dataclasses import dataclass

from ...doc_utils import export_module
from .context_variables import ContextVariables


@dataclass
@export_module("autogen")
class ContextExpression:
    """A class to evaluate logical expressions using context variables.

    Args:
        expression (str): A string containing a logical expression with context variable references.
            - Variable references use ${var_name} syntax: ${logged_in}, ${attempts}
            - String literals can use normal quotes: 'hello', "world"
            - Supported operators:
                - Logical: not/!, and/&, or/|
                - Comparison: >, <, >=, <=, ==, !=
            - Supported functions:
                - len(${var_name}): Gets the length of a list, string, or other collection
            - Parentheses can be used for grouping
            - Examples:
                - "not ${logged_in} and ${is_admin} or ${guest_checkout}"
                - "!${logged_in} & ${is_admin} | ${guest_checkout}"
                - "len(${orders}) > 0 & ${user_active}"
                - "len(${cart_items}) == 0 | ${checkout_started}"

    Raises:
        SyntaxError: If the expression cannot be parsed
        ValueError: If the expression contains disallowed operations
    """

    expression: str

    def __post_init__(self) -> None:
        # Validate the expression immediately upon creation
        try:
            # Extract variable references and replace with placeholders
            self._variable_names = self._extract_variable_names(self.expression)

            # Convert symbolic operators to Python keywords
            python_expr = self._convert_to_python_syntax(self.expression)

            # Sanitize for AST parsing
            sanitized_expr = self._prepare_for_ast(python_expr)

            # Use ast to parse and validate the expression
            self._ast = ast.parse(sanitized_expr, mode="eval")

            # Verify it only contains allowed operations
            self._validate_operations(self._ast.body)

            # Store the Python-syntax version for evaluation
            self._python_expr = python_expr

        except SyntaxError as e:
            raise SyntaxError(f"Invalid expression syntax in '{self.expression}': {str(e)}")
        except Exception as e:
            raise ValueError(f"Error validating expression '{self.expression}': {str(e)}")

    def _extract_variable_names(self, expr: str) -> list[str]:
        """Extract all variable references ${var_name} from the expression."""
        # Find all patterns like ${var_name}
        matches = re.findall(r"\${([^}]*)}", expr)
        return matches

    def _convert_to_python_syntax(self, expr: str) -> str:
        """Convert symbolic operators to Python keywords."""
        # We need to be careful about operators inside string literals
        # First, temporarily replace string literals with placeholders
        string_literals = []

        def replace_string_literal(match: re.Match[str]) -> str:
            string_literals.append(match.group(0))
            return f"__STRING_LITERAL_{len(string_literals) - 1}__"

        # Replace both single and double quoted strings
        expr_without_strings = re.sub(r"'[^']*'|\"[^\"]*\"", replace_string_literal, expr)

        # Handle the NOT operator (!) - no parentheses handling needed
        # Replace standalone ! before variables or expressions
        expr_without_strings = re.sub(r"!\s*(\${|\()", "not \\1", expr_without_strings)

        # Handle AND and OR operators - simpler approach without parentheses handling
        expr_without_strings = re.sub(r"\s+&\s+", " and ", expr_without_strings)
        expr_without_strings = re.sub(r"\s+\|\s+", " or ", expr_without_strings)

        # Now put string literals back
        for i, literal in enumerate(string_literals):
            expr_without_strings = expr_without_strings.replace(f"__STRING_LITERAL_{i}__", literal)

        return expr_without_strings

    def _prepare_for_ast(self, expr: str) -> str:
        """Convert the expression to valid Python for AST parsing by replacing variables with placeholders."""
        # Replace ${var_name} with var_name for AST parsing
        processed_expr = expr
        for var_name in self._variable_names:
            processed_expr = processed_expr.replace(f"${{{var_name}}}", var_name)

        return processed_expr

    def _validate_operations(self, node: ast.AST) -> None:
        """Recursively validate that only allowed operations exist in the AST."""
        allowed_node_types = (
            # Boolean operations
            ast.BoolOp,
            ast.UnaryOp,
            ast.And,
            ast.Or,
            ast.Not,
            # Comparison operations
            ast.Compare,
            ast.Eq,
            ast.NotEq,
            ast.Lt,
            ast.LtE,
            ast.Gt,
            ast.GtE,
            # Basic nodes
            ast.Name,
            ast.Load,
            ast.Constant,
            ast.Expression,
            # Support for basic numeric operations in comparisons
            ast.Num,
            ast.NameConstant,
            # Support for negative numbers
            ast.USub,
            ast.UnaryOp,
            # Support for string literals
            ast.Str,
            ast.Constant,
            # Support for function calls (specifically len())
            ast.Call,
        )

        if not isinstance(node, allowed_node_types):
            raise ValueError(f"Operation type {type(node).__name__} is not allowed in logical expressions")

        # Special validation for function calls - only allow len()
        if isinstance(node, ast.Call):
            if not (isinstance(node.func, ast.Name) and node.func.id == "len"):
                raise ValueError(f"Only the len() function is allowed, got: {getattr(node.func, 'id', 'unknown')}")
            if len(node.args) != 1:
                raise ValueError(f"len() function must have exactly one argument, got {len(node.args)}")

        # Special validation for Compare nodes
        if isinstance(node, ast.Compare):
            for op in node.ops:
                if not isinstance(op, (ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE)):
                    raise ValueError(f"Comparison operator {type(op).__name__} is not allowed")

        # Recursively check child nodes
        for child in ast.iter_child_nodes(node):
            self._validate_operations(child)

    def evaluate(self, context_variables: ContextVariables) -> bool:
        """Evaluate the expression using the provided context variables.

        Args:
            context_variables: Dictionary of context variables to use for evaluation

        Returns:
            bool: The result of evaluating the expression

        Raises:
            KeyError: If a variable referenced in the expression is not found in the context
        """
        # Create a modified expression that we can safely evaluate
        eval_expr = self._python_expr  # Use the Python-syntax version

        # First, handle len() functions with variable references inside
        len_pattern = r"len\(\${([^}]*)}\)"
        len_matches = list(re.finditer(len_pattern, eval_expr))

        # Process all len() operations first
        for match in len_matches:
            var_name = match.group(1)
            # Check if variable exists in context, raise KeyError if not
            if not context_variables.contains(var_name):
                raise KeyError(f"Missing context variable: '{var_name}'")

            var_value = context_variables.get(var_name)

            # Calculate the length - works for lists, strings, dictionaries, etc.
            try:
                length_value = len(var_value)  # type: ignore[arg-type]
            except TypeError:
                # If the value doesn't support len(), treat as 0
                length_value = 0

            # Replace the len() expression with the actual length
            full_match = match.group(0)
            eval_expr = eval_expr.replace(full_match, str(length_value))

        # Then replace remaining variable references with their values
        for var_name in self._variable_names:
            # Skip variables that were already processed in len() expressions
            if any(m.group(1) == var_name for m in len_matches):
                continue

            # Check if variable exists in context, raise KeyError if not
            if not context_variables.contains(var_name):
                raise KeyError(f"Missing context variable: '{var_name}'")

            # Get the value from context
            var_value = context_variables.get(var_name)

            # Format the value appropriately based on its type
            if isinstance(var_value, (bool, int, float)):
                formatted_value = str(var_value)
            elif isinstance(var_value, str):
                formatted_value = f"'{var_value}'"  # Quote strings
            elif isinstance(var_value, (list, dict, tuple)):
                # For collections, convert to their boolean evaluation
                formatted_value = str(bool(var_value))
            else:
                formatted_value = str(var_value)

            # Replace the variable reference with the formatted value
            eval_expr = eval_expr.replace(f"${{{var_name}}}", formatted_value)

        try:
            return eval(eval_expr)  # type: ignore[no-any-return]
        except Exception as e:
            raise ValueError(
                f"Error evaluating expression '{self.expression}' (are you sure you're using ${{my_context_variable_key}}): {str(e)}"
            )

    def __str__(self) -> str:
        return f"ContextExpression('{self.expression}')"
