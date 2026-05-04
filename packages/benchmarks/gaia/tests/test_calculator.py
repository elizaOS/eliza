"""Tests for calculator tool."""

import pytest
import math
from elizaos_gaia.tools.calculator import Calculator


class TestCalculator:
    """Tests for safe calculator."""
    
    @pytest.fixture
    def calc(self):
        """Create calculator instance."""
        return Calculator()


class TestBasicOperations(TestCalculator):
    """Tests for basic arithmetic operations."""
    
    def test_addition(self, calc):
        """Test addition."""
        result = calc.calculate("2 + 3")
        assert result.success
        assert result.result == 5
    
    def test_subtraction(self, calc):
        """Test subtraction."""
        result = calc.calculate("10 - 4")
        assert result.success
        assert result.result == 6
    
    def test_multiplication(self, calc):
        """Test multiplication."""
        result = calc.calculate("6 * 7")
        assert result.success
        assert result.result == 42
    
    def test_division(self, calc):
        """Test division."""
        result = calc.calculate("15 / 3")
        assert result.success
        assert result.result == 5
    
    def test_floor_division(self, calc):
        """Test floor division."""
        result = calc.calculate("17 // 5")
        assert result.success
        assert result.result == 3
    
    def test_modulo(self, calc):
        """Test modulo."""
        result = calc.calculate("17 % 5")
        assert result.success
        assert result.result == 2
    
    def test_power(self, calc):
        """Test exponentiation."""
        result = calc.calculate("2 ** 10")
        assert result.success
        assert result.result == 1024
    
    def test_power_caret_notation(self, calc):
        """Test power with caret notation."""
        result = calc.calculate("2^10")
        assert result.success
        assert result.result == 1024


class TestUnaryOperations(TestCalculator):
    """Tests for unary operations."""
    
    def test_negative(self, calc):
        """Test negative numbers."""
        result = calc.calculate("-5 + 3")
        assert result.success
        assert result.result == -2
    
    def test_positive(self, calc):
        """Test positive prefix."""
        result = calc.calculate("+5 + 3")
        assert result.success
        assert result.result == 8


class TestParentheses(TestCalculator):
    """Tests for parentheses."""
    
    def test_simple_parens(self, calc):
        """Test simple parentheses."""
        result = calc.calculate("(2 + 3) * 4")
        assert result.success
        assert result.result == 20
    
    def test_nested_parens(self, calc):
        """Test nested parentheses."""
        result = calc.calculate("((2 + 3) * (4 + 1))")
        assert result.success
        assert result.result == 25


class TestFunctions(TestCalculator):
    """Tests for mathematical functions."""
    
    def test_sqrt(self, calc):
        """Test square root."""
        result = calc.calculate("sqrt(16)")
        assert result.success
        assert result.result == 4
    
    def test_abs(self, calc):
        """Test absolute value."""
        result = calc.calculate("abs(-5)")
        assert result.success
        assert result.result == 5
    
    def test_round(self, calc):
        """Test rounding."""
        result = calc.calculate("round(3.7)")
        assert result.success
        assert result.result == 4
    
    def test_sin(self, calc):
        """Test sine."""
        result = calc.calculate("sin(0)")
        assert result.success
        assert abs(result.result) < 0.001
    
    def test_cos(self, calc):
        """Test cosine."""
        result = calc.calculate("cos(0)")
        assert result.success
        assert abs(result.result - 1) < 0.001
    
    def test_log(self, calc):
        """Test natural log."""
        result = calc.calculate("log(e)")
        assert result.success
        assert abs(result.result - 1) < 0.001
    
    def test_log10(self, calc):
        """Test log base 10."""
        result = calc.calculate("log10(100)")
        assert result.success
        assert result.result == 2


class TestConstants(TestCalculator):
    """Tests for mathematical constants."""
    
    def test_pi(self, calc):
        """Test pi constant."""
        result = calc.calculate("pi")
        assert result.success
        assert abs(result.result - math.pi) < 0.001
    
    def test_e(self, calc):
        """Test e constant."""
        result = calc.calculate("e")
        assert result.success
        assert abs(result.result - math.e) < 0.001
    
    def test_pi_in_expression(self, calc):
        """Test pi in expression."""
        result = calc.calculate("2 * pi")
        assert result.success
        assert abs(result.result - 2 * math.pi) < 0.001


class TestErrorHandling(TestCalculator):
    """Tests for error handling."""
    
    def test_division_by_zero(self, calc):
        """Test division by zero."""
        result = calc.calculate("5 / 0")
        assert not result.success
        assert "zero" in result.error.lower()
    
    def test_invalid_expression(self, calc):
        """Test invalid expression."""
        result = calc.calculate("2 +")
        assert not result.success
    
    def test_unknown_function(self, calc):
        """Test unknown function."""
        result = calc.calculate("unknown(5)")
        assert not result.success
        assert "unknown" in result.error.lower()
    
    def test_unknown_variable(self, calc):
        """Test unknown variable."""
        result = calc.calculate("x + 5")
        assert not result.success


class TestImplicitMultiplication(TestCalculator):
    """Tests for implicit multiplication."""
    
    def test_number_pi(self, calc):
        """Test number followed by pi."""
        result = calc.calculate("2pi")
        assert result.success
        assert abs(result.result - 2 * math.pi) < 0.001
    
    def test_number_parens(self, calc):
        """Test number followed by parentheses."""
        result = calc.calculate("3(4+5)")
        assert result.success
        assert result.result == 27


class TestPercentage(TestCalculator):
    """Tests for percentage calculations."""
    
    def test_percentage(self, calc):
        """Test percentage calculation."""
        result = calc.percentage(200, 15)
        assert result.success
        assert result.result == 30
    
    def test_percentage_change(self, calc):
        """Test percentage change."""
        result = calc.percentage_change(100, 120)
        assert result.success
        assert result.result == 20
    
    def test_percentage_change_decrease(self, calc):
        """Test percentage decrease."""
        result = calc.percentage_change(100, 80)
        assert result.success
        assert result.result == -20


class TestUnitConversion(TestCalculator):
    """Tests for unit conversion."""
    
    def test_meters_to_feet(self, calc):
        """Test meters to feet conversion."""
        result = calc.unit_conversion(1, "m", "ft")
        assert result.success
        assert abs(result.result - 3.28084) < 0.01
    
    def test_kg_to_pounds(self, calc):
        """Test kg to pounds conversion."""
        result = calc.unit_conversion(1, "kg", "lb")
        assert result.success
        assert abs(result.result - 2.20462) < 0.01
    
    def test_celsius_to_fahrenheit(self, calc):
        """Test temperature conversion."""
        result = calc.unit_conversion(0, "C", "F")
        assert result.success
        assert result.result == 32
    
    def test_unknown_unit(self, calc):
        """Test unknown unit conversion."""
        result = calc.unit_conversion(1, "foo", "bar")
        assert not result.success


class TestFormatting(TestCalculator):
    """Tests for result formatting."""
    
    def test_integer_formatting(self, calc):
        """Test integer result formatting."""
        result = calc.calculate("5 + 5")
        assert result.formatted == "10"
    
    def test_float_formatting(self, calc):
        """Test float result formatting."""
        result = calc.calculate("1 / 3")
        assert "0.33" in result.formatted
