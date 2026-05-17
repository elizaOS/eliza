"""
Data validation utilities for MCP Convert

Provides utilities for validating data integrity and consistency.
"""

from typing import Any, Dict, List, Callable, Optional
from dataclasses import dataclass
from enum import Enum


class ValidationType(Enum):
    """Types of validation rules"""
    REQUIRED_FIELD = "required_field"
    TYPE_CHECK = "type_check"
    VALUE_RANGE = "value_range" 
    CUSTOM_FUNCTION = "custom_function"
    RELATIONSHIP = "relationship"


@dataclass
class ValidationRule:
    """Definition of a validation rule"""
    name: str
    validation_type: ValidationType
    field_name: str
    expected_value: Any = None
    custom_validator: Optional[Callable] = None
    error_message: str = ""


class DataValidator:
    """Utility for validating data against rules"""
    
    def __init__(self):
        self.rules: List[ValidationRule] = []
    
    def add_rule(self, rule: ValidationRule):
        """Add a validation rule"""
        self.rules.append(rule)
    
    def add_required_field(self, field_name: str, error_message: str = None):
        """Add a required field validation rule"""
        error_msg = error_message or f"Field '{field_name}' is required"
        rule = ValidationRule(
            name=f"required_{field_name}",
            validation_type=ValidationType.REQUIRED_FIELD,
            field_name=field_name,
            error_message=error_msg
        )
        self.add_rule(rule)
    
    def add_type_check(self, field_name: str, expected_type: type, error_message: str = None):
        """Add a type validation rule"""
        if isinstance(expected_type, tuple):
            type_names = " or ".join(t.__name__ for t in expected_type)
            error_msg = error_message or f"Field '{field_name}' should be of type {type_names}"
        else:
            error_msg = error_message or f"Field '{field_name}' should be of type {expected_type.__name__}"
        rule = ValidationRule(
            name=f"type_{field_name}",
            validation_type=ValidationType.TYPE_CHECK,
            field_name=field_name,
            expected_value=expected_type,
            error_message=error_msg
        )
        self.add_rule(rule)
    
    def add_value_range(self, field_name: str, min_val: Any = None, max_val: Any = None, error_message: str = None):
        """Add a value range validation rule"""
        error_msg = error_message or f"Field '{field_name}' out of range"
        rule = ValidationRule(
            name=f"range_{field_name}",
            validation_type=ValidationType.VALUE_RANGE,
            field_name=field_name,
            expected_value={"min": min_val, "max": max_val},
            error_message=error_msg
        )
        self.add_rule(rule)
    
    def add_custom_validator(self, field_name: str, validator_func: Callable, error_message: str = None):
        """Add a custom validation rule"""
        error_msg = error_message or f"Custom validation failed for '{field_name}'"
        rule = ValidationRule(
            name=f"custom_{field_name}",
            validation_type=ValidationType.CUSTOM_FUNCTION,
            field_name=field_name,
            custom_validator=validator_func,
            error_message=error_msg
        )
        self.add_rule(rule)
    
    def validate_item(self, data: Dict[str, Any]) -> tuple[bool, List[str]]:
        """Validate a single data item against all rules"""
        is_valid = True
        errors = []
        
        for rule in self.rules:
            try:
                if not self._apply_rule(rule, data):
                    is_valid = False
                    errors.append(rule.error_message)
            except Exception as e:
                is_valid = False
                errors.append(f"Validation error in rule '{rule.name}': {str(e)}")
        
        return is_valid, errors
    
    def validate_list(self, data_list: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Validate a list of data items"""
        results = {
            "total_items": len(data_list),
            "valid_items": 0,
            "invalid_items": 0,
            "errors": []
        }
        
        for i, item in enumerate(data_list):
            is_valid, errors = self.validate_item(item)
            
            if is_valid:
                results["valid_items"] += 1
            else:
                results["invalid_items"] += 1
                results["errors"].append({
                    "item_index": i,
                    "errors": errors
                })
        
        return results
    
    def _apply_rule(self, rule: ValidationRule, data: Dict[str, Any]) -> bool:
        """Apply a single validation rule"""
        if rule.validation_type == ValidationType.REQUIRED_FIELD:
            return rule.field_name in data
        
        elif rule.validation_type == ValidationType.TYPE_CHECK:
            if rule.field_name not in data:
                return True  # Skip type check if field doesn't exist
            return isinstance(data[rule.field_name], rule.expected_value)
        
        elif rule.validation_type == ValidationType.VALUE_RANGE:
            if rule.field_name not in data:
                return True  # Skip range check if field doesn't exist
            
            value = data[rule.field_name]
            range_config = rule.expected_value
            
            if range_config["min"] is not None and value < range_config["min"]:
                return False
            if range_config["max"] is not None and value > range_config["max"]:
                return False
            return True
        
        elif rule.validation_type == ValidationType.CUSTOM_FUNCTION:
            if rule.field_name not in data:
                return True  # Skip custom check if field doesn't exist
            
            if rule.custom_validator:
                return rule.custom_validator(data[rule.field_name])
            return True
        
        return True


class StockDataValidator(DataValidator):
    """Specialized validator for stock data"""
    
    def __init__(self):
        super().__init__()
        self._setup_stock_rules()
    
    def _setup_stock_rules(self):
        """Setup common stock data validation rules"""
        # Required fields
        self.add_required_field("symbol")
        self.add_required_field("name")
        self.add_required_field("current_price")
        
        # Type checks
        self.add_type_check("current_price", (int, float))
        self.add_type_check("market_cap", (int, float))
        self.add_type_check("pe_ratio", (int, float))
        
        # Value ranges
        self.add_value_range("current_price", min_val=0)
        self.add_value_range("market_cap", min_val=0)
        
        # Custom validators
        self.add_custom_validator("symbol", 
                                lambda x: isinstance(x, str) and x.isupper() and len(x) <= 10,
                                "Symbol should be uppercase string <= 10 chars")


class PriceDataValidator(DataValidator):
    """Specialized validator for price data"""
    
    def __init__(self):
        super().__init__()
        self._setup_price_rules()
    
    def _setup_price_rules(self):
        """Setup price data validation rules"""
        # Required fields
        required_fields = ["symbol", "date", "open", "high", "low", "close", "volume"]
        for field in required_fields:
            self.add_required_field(field)
        
        # Type checks
        price_fields = ["open", "high", "low", "close"]
        for field in price_fields:
            self.add_type_check(field, (int, float))
        
        self.add_type_check("volume", int)
        
        # Value ranges
        for field in price_fields:
            self.add_value_range(field, min_val=0)
        self.add_value_range("volume", min_val=0)
        
        # Custom relationship validator
        self.add_custom_validator("high", self._validate_price_relationships, 
                                "Price relationships invalid (high >= low, etc.)")
    
    def _validate_price_relationships(self, high_value: float) -> bool:
        """Validate price relationships - this is a placeholder, actual validation needs full data"""
        return True  # This would need access to the full data item
    
    def validate_item(self, data: Dict[str, Any]) -> tuple[bool, List[str]]:
        """Override to add price relationship validation"""
        is_valid, errors = super().validate_item(data)
        
        # Additional price relationship validation
        if all(field in data for field in ["open", "high", "low", "close"]):
            try:
                high = float(data["high"])
                low = float(data["low"])
                open_price = float(data["open"])
                close_price = float(data["close"])
                
                if high < low:
                    is_valid = False
                    errors.append(f"High ({high}) < Low ({low})")
                if high < open_price:
                    is_valid = False
                    errors.append(f"High ({high}) < Open ({open_price})")
                if high < close_price:
                    is_valid = False
                    errors.append(f"High ({high}) < Close ({close_price})")
                if low > open_price:
                    is_valid = False
                    errors.append(f"Low ({low}) > Open ({open_price})")
                if low > close_price:
                    is_valid = False
                    errors.append(f"Low ({low}) > Close ({close_price})")
                    
            except (ValueError, TypeError):
                is_valid = False
                errors.append("Invalid numeric values in price data")
        
        return is_valid, errors