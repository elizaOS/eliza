"""
JSON database implementation for MCP Convert

Handles JSON file operations with error handling and validation.
"""

import json
from typing import Any, Dict, List, Optional
from .base import BaseDatabase


class JsonDatabase(BaseDatabase):
    """JSON file database implementation"""
    
    def load_data(self, filename: str) -> Dict[str, Any]:
        """Load JSON data from file"""
        file_path = self.get_file_path(filename)
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except FileNotFoundError:
            return {}
        except json.JSONDecodeError as e:
            print(f"Warning: Invalid JSON in {filename}: {e}")
            return {}
        except Exception as e:
            print(f"Error loading {filename}: {e}")
            return {}
    
    def save_data(self, filename: str, data: Dict[str, Any]) -> bool:
        """Save JSON data to file"""
        file_path = self.get_file_path(filename)
        try:
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            return True
        except Exception as e:
            print(f"Error saving {filename}: {e}")
            return False
    
    def get_nested_value(self, filename: str, keys: List[str], default: Any = None) -> Any:
        """Get nested value from JSON using key path"""
        data = self.load_data(filename)
        current = data
        
        try:
            for key in keys:
                current = current[key]
            return current
        except (KeyError, TypeError):
            return default
    
    def set_nested_value(self, filename: str, keys: List[str], value: Any) -> bool:
        """Set nested value in JSON using key path"""
        data = self.load_data(filename)
        current = data
        
        # Navigate to parent of target key
        for key in keys[:-1]:
            if key not in current:
                current[key] = {}
            current = current[key]
        
        # Set the final value
        current[keys[-1]] = value
        return self.save_data(filename, data)
    
    def append_to_list(self, filename: str, key: str, item: Any) -> bool:
        """Append item to a list in JSON file"""
        data = self.load_data(filename)
        
        if key not in data:
            data[key] = []
        elif not isinstance(data[key], list):
            data[key] = [data[key]]
        
        data[key].append(item)
        return self.save_data(filename, data)
    
    def query_by_field(self, filename: str, field: str, value: Any) -> List[Dict[str, Any]]:
        """Query JSON array by field value"""
        data = self.load_data(filename)
        
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict) and item.get(field) == value]
        elif isinstance(data, dict):
            return [item for item in data.values() if isinstance(item, dict) and item.get(field) == value]
        
        return []
    
    def validate_schema(self, filename: str, required_fields: List[str]) -> bool:
        """Validate that JSON contains required fields"""
        data = self.load_data(filename)
        
        if isinstance(data, dict):
            return all(field in data for field in required_fields)
        elif isinstance(data, list) and data:
            # Check first item if it's a list
            first_item = data[0]
            if isinstance(first_item, dict):
                return all(field in first_item for field in required_fields)
        
        return False