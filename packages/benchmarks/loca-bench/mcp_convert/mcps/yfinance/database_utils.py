"""
Database utilities for YFinance MCP Server

Handles data operations for the simplified YFinance implementation.
"""

import os
import sys
from typing import Dict, List, Any, Optional

# Add project root to path
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, project_root)

from common.database import JsonDatabase, CsvDatabase


class YFinanceDatabase:
    """Database handler for YFinance data"""
    
    def __init__(self, data_dir: str = None):
        """Initialize database with data directory"""
        if data_dir is None:
            # Default to data directory in the same folder as this file
            data_dir = os.path.join(os.path.dirname(__file__), "data")
        
        self.json_db = JsonDatabase(data_dir)
        self.csv_db = CsvDatabase(data_dir)
        
        # File mappings
        self.stocks_file = "stocks.json"
        self.prices_file = "historical_prices.csv"
        self.news_file = "news.json"
        self.financial_file = "financial_statements.json"
        self.holders_file = "holders.json"
        self.options_file = "options.json"
        self.actions_file = "stock_actions.json"
        self.recommendations_file = "recommendations.json"
    
    def get_stock_info(self, ticker: str) -> Optional[Dict[str, Any]]:
        """Get stock information for a ticker"""
        stocks = self.json_db.load_data(self.stocks_file)
        return stocks.get(ticker.upper())
    
    def get_historical_prices(self, ticker: str, period: str = "1mo", interval: str = "1d") -> List[Dict[str, Any]]:
        """Get historical prices for a ticker"""
        return self.csv_db.query_records(self.prices_file, {"symbol": ticker.upper()})
    
    def get_news(self, ticker: str) -> List[Dict[str, Any]]:
        """Get news for a ticker"""
        return self.json_db.query_by_field(self.news_file, "symbol", ticker.upper())
    
    def get_financial_statement(self, ticker: str, statement_type: str) -> Dict[str, Any]:
        """Get financial statement for a ticker"""
        return self.json_db.get_nested_value(
            self.financial_file, 
            [ticker.upper(), statement_type], 
            default={}
        )
    
    def get_holder_info(self, ticker: str, holder_type: str) -> List[Dict[str, Any]]:
        """Get holder information for a ticker"""
        return self.json_db.get_nested_value(
            self.holders_file,
            [ticker.upper(), holder_type],
            default=[]
        )
    
    def get_stock_actions(self, ticker: str) -> Dict[str, List[Dict[str, Any]]]:
        """Get stock actions (dividends and splits) for a ticker"""
        return self.json_db.get_nested_value(
            self.actions_file,
            [ticker.upper()],
            default={"dividends": [], "splits": []}
        )
    
    def get_option_expiration_dates(self, ticker: str) -> List[str]:
        """Get option expiration dates for a ticker"""
        return self.json_db.get_nested_value(
            self.options_file,
            [ticker.upper(), "expiration_dates"],
            default=[]
        )
    
    def get_option_chain(self, ticker: str, expiration_date: str, option_type: str) -> List[Dict[str, Any]]:
        """Get option chain for a ticker, expiration date, and option type"""
        return self.json_db.get_nested_value(
            self.options_file,
            [ticker.upper(), "chains", expiration_date, option_type],
            default=[]
        )
    
    def get_recommendations(self, ticker: str, recommendation_type: str = "recommendations") -> Any:
        """Get recommendations for a ticker"""
        return self.json_db.get_nested_value(
            self.recommendations_file,
            [ticker.upper(), recommendation_type],
            default={}
        )
    
    # Data modification methods
    def add_stock(self, ticker: str, stock_data: Dict[str, Any]) -> bool:
        """Add or update stock information"""
        stocks = self.json_db.load_data(self.stocks_file)
        stocks[ticker.upper()] = stock_data
        return self.json_db.save_data(self.stocks_file, stocks)
    
    def add_historical_price(self, ticker: str, price_data: Dict[str, Any]) -> bool:
        """Add historical price data"""
        price_data["symbol"] = ticker.upper()
        return self.csv_db.append_record(self.prices_file, price_data)
    
    def add_news(self, news_item: Dict[str, Any]) -> bool:
        """Add news item"""
        return self.json_db.append_to_list(self.news_file, "news", news_item)
    
    # Utility methods
    def get_available_tickers(self) -> List[str]:
        """Get list of available tickers"""
        stocks = self.json_db.load_data(self.stocks_file)
        return list(stocks.keys())
    
    def validate_ticker(self, ticker: str) -> bool:
        """Check if ticker exists in database"""
        return ticker.upper() in self.get_available_tickers()
    
    def get_database_stats(self) -> Dict[str, Any]:
        """Get database statistics"""
        stats = {
            "total_stocks": len(self.get_available_tickers()),
            "files": {}
        }
        
        # File sizes and counts
        files_to_check = [
            self.stocks_file, self.prices_file, self.news_file,
            self.financial_file, self.holders_file, self.options_file,
            self.actions_file, self.recommendations_file
        ]
        
        for filename in files_to_check:
            if self.json_db.file_exists(filename) or self.csv_db.file_exists(filename):
                size = max(
                    self.json_db.get_file_size(filename),
                    self.csv_db.get_file_size(filename)
                )
                stats["files"][filename] = {
                    "size_bytes": size,
                    "exists": True
                }
            else:
                stats["files"][filename] = {
                    "size_bytes": 0,
                    "exists": False
                }
        
        return stats