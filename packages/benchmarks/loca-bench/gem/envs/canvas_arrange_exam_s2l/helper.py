"""
Helper utilities for Canvas Arrange Exam S2L Environment
"""

import re


def normalize_str(s: str) -> str:
    """
    Normalize a string for comparison by:
    - Converting to lowercase
    - Removing extra whitespace
    - Removing special characters
    
    Args:
        s: String to normalize
        
    Returns:
        Normalized string
    """
    if not isinstance(s, str):
        s = str(s)
    
    # Convert to lowercase
    s = s.lower()
    
    # Remove extra whitespace
    s = ' '.join(s.split())
    
    # Remove special punctuation but keep basic characters
    # Keep alphanumeric, spaces, and common punctuation
    s = re.sub(r'[^\w\s\-@./:]', '', s)
    
    return s.strip()

