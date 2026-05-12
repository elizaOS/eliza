"""
Base database interface for MCP Convert

Provides abstract base class for all database implementations.
"""

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional
import os


class BaseDatabase(ABC):
    """Abstract base class for database implementations"""
    
    def __init__(self, data_dir: str = "data"):
        """Initialize database with data directory"""
        self.data_dir = data_dir
        self.ensure_data_dir()
    
    def ensure_data_dir(self):
        """Ensure data directory exists"""
        if not os.path.exists(self.data_dir):
            os.makedirs(self.data_dir)
    
    def get_file_path(self, filename: str) -> str:
        """Get full path for a data file"""
        return os.path.join(self.data_dir, filename)
    
    @abstractmethod
    def load_data(self, filename: str) -> Any:
        """Load data from file"""
        pass
    
    @abstractmethod
    def save_data(self, filename: str, data: Any) -> bool:
        """Save data to file"""
        pass
    
    def file_exists(self, filename: str) -> bool:
        """Check if file exists"""
        return os.path.exists(self.get_file_path(filename))
    
    def list_files(self, extension: str = None) -> List[str]:
        """List files in data directory"""
        if not os.path.exists(self.data_dir):
            return []
        
        files = os.listdir(self.data_dir)
        if extension:
            files = [f for f in files if f.endswith(extension)]
        return files
    
    def get_file_size(self, filename: str) -> int:
        """Get file size in bytes"""
        file_path = self.get_file_path(filename)
        if os.path.exists(file_path):
            return os.path.getsize(file_path)
        return 0