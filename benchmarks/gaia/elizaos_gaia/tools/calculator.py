"""
Calculator Tool for GAIA Benchmark

Provides safe mathematical calculations and expression evaluation.
"""

import ast
import logging
import math
import operator
import re
from collections.abc import Callable
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class CalculationResult:
    """Result of a calculation."""
    expression: str
    result: float | int | str
    formatted: str
    success: bool
    error: str | None = None


class Calculator:
    """Safe calculator for mathematical operations in GAIA benchmark."""

    # Allowed operators
    OPERATORS = {
        ast.Add: operator.add,
        ast.Sub: operator.sub,
        ast.Mult: operator.mul,
        ast.Div: operator.truediv,
        ast.FloorDiv: operator.floordiv,
        ast.Mod: operator.mod,
        ast.Pow: operator.pow,
        ast.USub: operator.neg,
        ast.UAdd: operator.pos,
    }

    # Allowed functions
    FUNCTIONS = {
        "abs": abs,
        "round": round,
        "min": min,
        "max": max,
        "sum": sum,
        "len": len,
        "int": int,
        "float": float,
        "sqrt": math.sqrt,
        "pow": pow,
        "log": math.log,
        "log10": math.log10,
        "log2": math.log2,
        "exp": math.exp,
        "sin": math.sin,
        "cos": math.cos,
        "tan": math.tan,
        "asin": math.asin,
        "acos": math.acos,
        "atan": math.atan,
        "atan2": math.atan2,
        "sinh": math.sinh,
        "cosh": math.cosh,
        "tanh": math.tanh,
        "ceil": math.ceil,
        "floor": math.floor,
        "factorial": math.factorial,
        "gcd": math.gcd,
        "lcm": math.lcm,
        "radians": math.radians,
        "degrees": math.degrees,
    }

    # Allowed constants
    CONSTANTS = {
        "pi": math.pi,
        "e": math.e,
        "tau": math.tau,
        "inf": math.inf,
    }

    def __init__(self, precision: int = 10):
        """
        Initialize calculator.

        Args:
            precision: Decimal precision for results
        """
        self.precision = precision

    def calculate(self, expression: str) -> CalculationResult:
        """
        Safely evaluate a mathematical expression.

        Args:
            expression: Mathematical expression to evaluate

        Returns:
            CalculationResult with the answer
        """
        try:
            # Preprocess expression
            processed = self._preprocess(expression)

            # Parse and evaluate
            result = self._safe_eval(processed)

            # Format result
            if isinstance(result, float):
                if result.is_integer():
                    formatted = str(int(result))
                else:
                    formatted = f"{result:.{self.precision}g}"
            else:
                formatted = str(result)

            return CalculationResult(
                expression=expression,
                result=result,
                formatted=formatted,
                success=True,
            )

        except Exception as e:
            logger.error(f"Calculation failed for '{expression}': {e}")
            return CalculationResult(
                expression=expression,
                result=0,
                formatted="",
                success=False,
                error=str(e),
            )

    def _preprocess(self, expression: str) -> str:
        """Preprocess expression for evaluation."""
        # Remove whitespace
        expr = expression.strip()

        # Replace common mathematical notation
        expr = expr.replace("^", "**")  # Power notation
        expr = expr.replace("×", "*")   # Multiplication
        expr = expr.replace("÷", "/")   # Division
        expr = expr.replace("√", "sqrt")  # Square root

        # Handle implicit multiplication carefully to avoid breaking function names
        # 1. Number followed by letter at start or after operator: 2pi -> 2*pi
        #    But NOT in function names like log10, atan2
        expr = re.sub(r"(?<![a-zA-Z])(\d+)([a-zA-Z])", r"\1*\2", expr)

        # 2. Number followed by ( when NOT part of a function name
        #    3(4+5) -> 3*(4+5), but NOT log10(x) -> log10*(x)
        expr = re.sub(r"(?<![a-zA-Z0-9])(\d+)(\()", r"\1*\2", expr)

        # 3. Close paren followed by number or letter/paren
        expr = re.sub(r"(\))(\d)", r"\1*\2", expr)
        expr = re.sub(r"(\))([a-zA-Z(])", r"\1*\2", expr)

        return expr

    def _safe_eval(self, expression: str) -> float | int:
        """Safely evaluate expression using AST."""
        try:
            tree = ast.parse(expression, mode="eval")
        except SyntaxError as e:
            raise ValueError(f"Invalid expression: {e}") from e

        return self._eval_node(tree.body)

    def _get_function(self, name: str) -> Callable[..., float | int] | None:
        """Get function by name (case-insensitive).

        Args:
            name: Function name to look up

        Returns:
            The function if found, None otherwise
        """
        name_lower = name.lower()
        for func_name, func in self.FUNCTIONS.items():
            if func_name.lower() == name_lower:
                return func
        return None

    def _get_constant(self, name: str) -> float | None:
        """Get constant by name (case-insensitive).

        Args:
            name: Constant name to look up

        Returns:
            The constant value if found, None otherwise
        """
        name_lower = name.lower()
        for const_name, value in self.CONSTANTS.items():
            if const_name.lower() == name_lower:
                return value
        return None

    def _eval_node(self, node: ast.AST) -> float | int:
        """Recursively evaluate AST node."""
        if isinstance(node, ast.Constant):
            if isinstance(node.value, (int, float)):
                return node.value
            raise ValueError(f"Invalid constant: {node.value}")

        elif isinstance(node, ast.Name):
            # Check constants (case-insensitive)
            const_value = self._get_constant(node.id)
            if const_value is not None:
                return const_value
            raise ValueError(f"Unknown variable: {node.id}")

        elif isinstance(node, ast.BinOp):
            op_type = type(node.op)
            if op_type not in self.OPERATORS:
                raise ValueError(f"Unsupported operator: {op_type.__name__}")

            left = self._eval_node(node.left)
            right = self._eval_node(node.right)

            # Special handling for division by zero
            if op_type in (ast.Div, ast.FloorDiv, ast.Mod) and right == 0:
                raise ValueError("Division by zero")

            return self.OPERATORS[op_type](left, right)

        elif isinstance(node, ast.UnaryOp):
            op_type = type(node.op)
            if op_type not in self.OPERATORS:
                raise ValueError(f"Unsupported operator: {op_type.__name__}")

            operand = self._eval_node(node.operand)
            return self.OPERATORS[op_type](operand)

        elif isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name):
                raise ValueError("Invalid function call")

            func = self._get_function(node.func.id)
            if func is None:
                raise ValueError(f"Unknown function: {node.func.id}")

            args = [self._eval_node(arg) for arg in node.args]
            return func(*args)

        elif isinstance(node, ast.List):
            # Lists are used for functions like min([1,2,3])
            evaluated = [self._eval_node(elem) for elem in node.elts]
            # Return as a list that can be passed to functions
            return evaluated  # type: ignore[return-value]

        elif isinstance(node, ast.Tuple):
            # Tuples are used for functions like atan2(y, x)
            evaluated = tuple(self._eval_node(elem) for elem in node.elts)
            return evaluated  # type: ignore[return-value]

        else:
            raise ValueError(f"Unsupported expression type: {type(node).__name__}")

    def solve_equation(
        self,
        equation: str,
        variable: str = "x",
    ) -> CalculationResult:
        """
        Solve a simple equation for a variable.

        Args:
            equation: Equation string (e.g., "2*x + 3 = 7")
            variable: Variable to solve for

        Returns:
            CalculationResult with the solution
        """
        try:
            # Split by equals sign
            if "=" not in equation:
                raise ValueError("Equation must contain '='")

            left, right = equation.split("=", 1)
            left = left.strip()
            right = right.strip()

            # Try symbolic solving with sympy if available
            try:
                import sympy

                x = sympy.Symbol(variable)
                left_expr = sympy.sympify(left)
                right_expr = sympy.sympify(right)

                solutions = sympy.solve(left_expr - right_expr, x)

                if not solutions:
                    raise ValueError("No solution found")

                # Take first solution
                result = float(solutions[0])

                return CalculationResult(
                    expression=equation,
                    result=result,
                    formatted=str(result),
                    success=True,
                )

            except ImportError:
                # Fall back to simple linear equation solving
                return self._solve_linear(left, right, variable)

        except Exception as e:
            return CalculationResult(
                expression=equation,
                result=0,
                formatted="",
                success=False,
                error=str(e),
            )

    def _solve_linear(
        self,
        left: str,
        right: str,
        variable: str,
    ) -> CalculationResult:
        """Solve a simple linear equation ax + b = c."""
        # Very basic linear equation solver
        # For complex equations, sympy should be used
        _ = (left, right)  # Acknowledge the parameters

        # This is a simplified approach - requires sympy for real solving
        raise ValueError(
            "Complex equation solving requires sympy. "
            "Install with: pip install sympy"
        )

    def percentage(
        self,
        value: float,
        percentage: float,
    ) -> CalculationResult:
        """Calculate percentage of a value."""
        result = value * percentage / 100
        return CalculationResult(
            expression=f"{percentage}% of {value}",
            result=result,
            formatted=str(result),
            success=True,
        )

    def percentage_change(
        self,
        old_value: float,
        new_value: float,
    ) -> CalculationResult:
        """Calculate percentage change between two values."""
        if old_value == 0:
            return CalculationResult(
                expression=f"Change from {old_value} to {new_value}",
                result=0,
                formatted="",
                success=False,
                error="Cannot calculate percentage change from zero",
            )

        result = ((new_value - old_value) / old_value) * 100
        return CalculationResult(
            expression=f"Change from {old_value} to {new_value}",
            result=result,
            formatted=f"{result:+.2f}%",
            success=True,
        )

    def unit_conversion(
        self,
        value: float,
        from_unit: str,
        to_unit: str,
    ) -> CalculationResult:
        """Convert between common units."""
        # Length conversions (to meters)
        length_to_m = {
            "m": 1, "meter": 1, "meters": 1,
            "km": 1000, "kilometer": 1000, "kilometers": 1000,
            "cm": 0.01, "centimeter": 0.01, "centimeters": 0.01,
            "mm": 0.001, "millimeter": 0.001, "millimeters": 0.001,
            "mi": 1609.344, "mile": 1609.344, "miles": 1609.344,
            "ft": 0.3048, "foot": 0.3048, "feet": 0.3048,
            "in": 0.0254, "inch": 0.0254, "inches": 0.0254,
            "yd": 0.9144, "yard": 0.9144, "yards": 0.9144,
        }

        # Weight conversions (to kg)
        weight_to_kg = {
            "kg": 1, "kilogram": 1, "kilograms": 1,
            "g": 0.001, "gram": 0.001, "grams": 0.001,
            "mg": 0.000001, "milligram": 0.000001, "milligrams": 0.000001,
            "lb": 0.453592, "pound": 0.453592, "pounds": 0.453592,
            "oz": 0.0283495, "ounce": 0.0283495, "ounces": 0.0283495,
        }

        # Temperature requires special handling

        from_lower = from_unit.lower()
        to_lower = to_unit.lower()

        # Try length
        if from_lower in length_to_m and to_lower in length_to_m:
            meters = value * length_to_m[from_lower]
            result = meters / length_to_m[to_lower]
        # Try weight
        elif from_lower in weight_to_kg and to_lower in weight_to_kg:
            kg = value * weight_to_kg[from_lower]
            result = kg / weight_to_kg[to_lower]
        # Temperature
        elif from_lower in ["c", "celsius"] and to_lower in ["f", "fahrenheit"]:
            result = (value * 9/5) + 32
        elif from_lower in ["f", "fahrenheit"] and to_lower in ["c", "celsius"]:
            result = (value - 32) * 5/9
        elif from_lower in ["c", "celsius"] and to_lower in ["k", "kelvin"]:
            result = value + 273.15
        elif from_lower in ["k", "kelvin"] and to_lower in ["c", "celsius"]:
            result = value - 273.15
        else:
            return CalculationResult(
                expression=f"{value} {from_unit} to {to_unit}",
                result=0,
                formatted="",
                success=False,
                error=f"Unknown unit conversion: {from_unit} to {to_unit}",
            )

        return CalculationResult(
            expression=f"{value} {from_unit} to {to_unit}",
            result=result,
            formatted=f"{result:.6g} {to_unit}",
            success=True,
        )
