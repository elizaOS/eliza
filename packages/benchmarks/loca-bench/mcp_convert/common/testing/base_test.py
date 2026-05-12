"""
Base test classes for MCP Convert

Provides common testing functionality for all MCP implementations.
"""

import pytest
import asyncio
import json
from typing import Any, Dict, List, Optional
from unittest.mock import Mock, patch
import mcp.types as types


class BaseMCPTest:
    """Base class for MCP server tests"""
    
    @pytest.fixture
    def server_instance(self):
        """Override this fixture to return your MCP server instance"""
        raise NotImplementedError("Subclasses must implement server_instance fixture")
    
    @pytest.fixture
    def sample_data(self):
        """Override this fixture to return sample test data"""
        return {}
    
    def assert_valid_json_response(self, response: List[types.TextContent]):
        """Assert that response is valid JSON"""
        assert isinstance(response, list)
        assert len(response) == 1
        assert isinstance(response[0], types.TextContent)
        
        # Try to parse as JSON
        json.loads(response[0].text)
    
    def assert_error_response(self, response: List[types.TextContent], error_text: str = None):
        """Assert that response is an error"""
        assert isinstance(response, list)
        assert len(response) == 1
        assert isinstance(response[0], types.TextContent)
        
        if error_text:
            assert error_text in response[0].text
    
    def create_mock_tool_call(self, tool_name: str, arguments: Dict[str, Any]):
        """Create a mock tool call for testing"""
        return {
            "name": tool_name,
            "arguments": arguments
        }


class BaseDataTest:
    """Base class for data validation tests"""
    
    @pytest.fixture
    def database_instance(self):
        """Override this fixture to return your database instance"""
        raise NotImplementedError("Subclasses must implement database_instance fixture")
    
    def assert_required_fields(self, data: Dict[str, Any], required_fields: List[str]):
        """Assert that data contains all required fields"""
        for field in required_fields:
            assert field in data, f"Missing required field: {field}"
    
    def assert_data_types(self, data: Dict[str, Any], type_mapping: Dict[str, type]):
        """Assert that data fields have correct types"""
        for field, expected_type in type_mapping.items():
            if field in data:
                assert isinstance(data[field], expected_type), \
                    f"Field {field} should be {expected_type.__name__}, got {type(data[field]).__name__}"
    
    def assert_non_empty_list(self, data: List[Any], list_name: str = "list"):
        """Assert that list is not empty"""
        assert isinstance(data, list), f"{list_name} should be a list"
        assert len(data) > 0, f"{list_name} should not be empty"
    
    def assert_valid_price_data(self, price_entry: Dict[str, Any]):
        """Assert that price data has valid relationships"""
        required_fields = ["open", "high", "low", "close"]
        self.assert_required_fields(price_entry, required_fields)
        
        # Validate price relationships
        high = price_entry["high"]
        low = price_entry["low"]
        open_price = price_entry["open"]
        close_price = price_entry["close"]
        
        assert high >= low, f"High ({high}) should be >= Low ({low})"
        assert high >= open_price, f"High ({high}) should be >= Open ({open_price})"
        assert high >= close_price, f"High ({high}) should be >= Close ({close_price})"
        assert low <= open_price, f"Low ({low}) should be <= Open ({open_price})"
        assert low <= close_price, f"Low ({low}) should be <= Close ({close_price})"


class AsyncTestMixin:
    """Mixin for async test utilities"""
    
    @staticmethod
    async def run_async_test(coro):
        """Run an async test function"""
        return await coro
    
    def run_in_loop(self, coro):
        """Run coroutine in event loop"""
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()


class MockDataMixin:
    """Mixin for creating mock data"""
    
    def create_mock_stock_info(self, ticker: str = "TEST") -> Dict[str, Any]:
        """Create mock stock information"""
        return {
            "symbol": ticker,
            "name": f"Test Company {ticker}",
            "sector": "Technology",
            "industry": "Software",
            "current_price": 100.0,
            "market_cap": 1000000000,
            "pe_ratio": 20.0,
            "dividend_yield": 0.02
        }
    
    def create_mock_price_data(self, ticker: str = "TEST", count: int = 5) -> List[Dict[str, Any]]:
        """Create mock historical price data"""
        prices = []
        base_price = 100.0
        
        for i in range(count):
            price = base_price + (i * 2)
            prices.append({
                "symbol": ticker,
                "date": f"2024-01-{i+1:02d}",
                "open": price,
                "high": price + 2,
                "low": price - 1,
                "close": price + 1,
                "volume": 1000000 + (i * 10000),
                "adj_close": price + 1
            })
        
        return prices
    
    def create_mock_news_item(self, ticker: str = "TEST") -> Dict[str, Any]:
        """Create mock news item"""
        return {
            "symbol": ticker,
            "title": f"{ticker} Reports Strong Earnings",
            "summary": f"{ticker} exceeded expectations with strong quarterly results.",
            "published_date": "2024-01-01",
            "source": "Test News",
            "url": f"https://example.com/news/{ticker.lower()}"
        }