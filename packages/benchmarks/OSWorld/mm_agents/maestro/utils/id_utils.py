# id_utils.py
import uuid
import time
import hashlib
from typing import Optional

# Module-level counter for sequential IDs
_sequential_counter = 1

def generate_uuid() -> str:
    """Generate a random UUID string"""
    return str(uuid.uuid4())

def generate_short_id(prefix: str = "", length: int = 8) -> str:
    """Generate a short random ID with optional prefix"""
    # Generate UUID and take first N characters
    short_uuid = str(uuid.uuid4()).replace("-", "")[:length]
    return f"{prefix}{short_uuid}" if prefix else short_uuid

def generate_timestamp_id(prefix: str = "") -> str:
    """Generate ID based on current timestamp"""
    timestamp = int(time.time() * 1000)  # milliseconds
    return f"{prefix}{timestamp}" if prefix else str(timestamp)

def generate_hash_id(content: str, prefix: str = "", length: int = 8) -> str:
    """Generate ID based on content hash"""
    hash_obj = hashlib.md5(content.encode('utf-8'))
    hash_hex = hash_obj.hexdigest()[:length]
    return f"{prefix}{hash_hex}" if prefix else hash_hex

def generate_sequential_id(prefix: str = "", start: int = 1) -> str:
    """Generate sequential ID (not thread-safe, use with caution)"""
    global _sequential_counter
    if start != 1:  # Reset counter if different start value
        _sequential_counter = start
    
    current_id = _sequential_counter
    _sequential_counter += 1
    return f"{prefix}{current_id}" if prefix else str(current_id)

def generate_composite_id(prefix: str = "", include_timestamp: bool = True, 
                         include_uuid: bool = True, separator: str = "_") -> str:
    """Generate composite ID with multiple components"""
    parts = []
    
    if prefix:
        parts.append(prefix)
    
    if include_timestamp:
        parts.append(str(int(time.time() * 1000)))
    
    if include_uuid:
        parts.append(str(uuid.uuid4())[:8])
    
    return separator.join(parts)

def validate_id_format(id_string: str, expected_prefix: Optional[str] = None, 
                      min_length: int = 1, max_length: int = 100) -> bool:
    """Validate ID format and constraints"""
    if not id_string or not isinstance(id_string, str):
        return False
    
    if len(id_string) < min_length or len(id_string) > max_length:
        return False
    
    if expected_prefix and not id_string.startswith(expected_prefix):
        return False
    
    return True 