"""
CSV database implementation for MCP Convert

Handles CSV file operations with pandas integration.
"""

import pandas as pd
from typing import Any, Dict, List, Optional
from .base import BaseDatabase


class CsvDatabase(BaseDatabase):
    """CSV file database implementation"""
    
    def load_data(self, filename: str) -> pd.DataFrame:
        """Load CSV data as pandas DataFrame"""
        file_path = self.get_file_path(filename)
        try:
            return pd.read_csv(file_path)
        except FileNotFoundError:
            return pd.DataFrame()
        except Exception as e:
            print(f"Error loading CSV {filename}: {e}")
            return pd.DataFrame()
    
    def save_data(self, filename: str, data: pd.DataFrame) -> bool:
        """Save DataFrame to CSV file"""
        file_path = self.get_file_path(filename)
        try:
            data.to_csv(file_path, index=False)
            return True
        except Exception as e:
            print(f"Error saving CSV {filename}: {e}")
            return False
    
    def load_as_records(self, filename: str) -> List[Dict[str, Any]]:
        """Load CSV data as list of dictionaries"""
        df = self.load_data(filename)
        if df.empty:
            return []
        return df.to_dict('records')
    
    def append_record(self, filename: str, record: Dict[str, Any]) -> bool:
        """Append a single record to CSV file"""
        df = self.load_data(filename)
        new_row = pd.DataFrame([record])
        df = pd.concat([df, new_row], ignore_index=True)
        return self.save_data(filename, df)
    
    def query_records(self, filename: str, filters: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Query CSV records with filters"""
        df = self.load_data(filename)
        if df.empty:
            return []
        
        # Apply filters
        for column, value in filters.items():
            if column in df.columns:
                df = df[df[column] == value]
        
        return df.to_dict('records')
    
    def get_unique_values(self, filename: str, column: str) -> List[Any]:
        """Get unique values from a column"""
        df = self.load_data(filename)
        if df.empty or column not in df.columns:
            return []
        
        return df[column].unique().tolist()
    
    def aggregate_data(self, filename: str, group_by: str, agg_func: str, agg_column: str) -> Dict[str, Any]:
        """Aggregate data by grouping column"""
        df = self.load_data(filename)
        if df.empty or group_by not in df.columns or agg_column not in df.columns:
            return {}
        
        try:
            if agg_func == 'mean':
                result = df.groupby(group_by)[agg_column].mean()
            elif agg_func == 'sum':
                result = df.groupby(group_by)[agg_column].sum()
            elif agg_func == 'count':
                result = df.groupby(group_by)[agg_column].count()
            elif agg_func == 'max':
                result = df.groupby(group_by)[agg_column].max()
            elif agg_func == 'min':
                result = df.groupby(group_by)[agg_column].min()
            else:
                return {}
            
            return result.to_dict()
        except Exception as e:
            print(f"Error aggregating data: {e}")
            return {}
    
    def validate_columns(self, filename: str, required_columns: List[str]) -> bool:
        """Validate that CSV contains required columns"""
        df = self.load_data(filename)
        if df.empty:
            return False
        
        return all(column in df.columns for column in required_columns)
    
    def get_column_stats(self, filename: str, column: str) -> Dict[str, Any]:
        """Get statistical information about a column"""
        df = self.load_data(filename)
        if df.empty or column not in df.columns:
            return {}
        
        try:
            series = df[column]
            if pd.api.types.is_numeric_dtype(series):
                return {
                    'count': series.count(),
                    'mean': series.mean(),
                    'std': series.std(),
                    'min': series.min(),
                    'max': series.max(),
                    'median': series.median()
                }
            else:
                return {
                    'count': series.count(),
                    'unique': series.nunique(),
                    'top': series.mode().iloc[0] if not series.mode().empty else None,
                    'freq': series.value_counts().iloc[0] if not series.empty else 0
                }
        except Exception as e:
            print(f"Error getting column stats: {e}")
            return {}