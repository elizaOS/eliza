#!/usr/bin/env python3
"""
Simplified YFinance MCP Server

A Model Context Protocol server that provides Yahoo Finance-like functionality
using local JSON/CSV files as the database instead of connecting to external APIs.

Uses the common MCP framework for simplified development.
"""

import asyncio
import sys
import os

# Add project root to path
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, project_root)

from common.mcp.server_base import BaseMCPServer
from common.mcp.tools import ToolRegistry, create_ticker_tool_schema
from mcps.yfinance.database_utils import YFinanceDatabase


class YFinanceMCPServer(BaseMCPServer):
    """YFinance MCP server implementation"""
    
    def __init__(self):
        super().__init__("simplified-yfinance", "1.0.0")
        self.db = YFinanceDatabase()
        self.tool_registry = ToolRegistry()
        self.setup_tools()
    
    def setup_tools(self):
        """Setup all YFinance tools"""
        
        # Tool 1: Get historical stock prices
        self.tool_registry.register(
            name="get_historical_stock_prices",
            description="Get historical stock prices for a given ticker symbol from local database. Include the following information: Date, Open, High, Low, Close, Volume, Adj Close.",
            input_schema=create_ticker_tool_schema(
                additional_optional={
                    "period": {
                        "type": "string",
                        "description": "Valid periods: 1d,5d,1mo,3mo,6mo,1y,2y,5y,10y,ytd,max. Default is '1mo'",
                        "default": "1mo"
                    },
                    "interval": {
                        "type": "string",
                        "description": "Valid intervals: 1m,2m,5m,15m,30m,60m,90m,1h,1d,5d,1wk,1mo,3mo. Default is '1d'",
                        "default": "1d"
                    }
                }
            ),
            handler=self.get_historical_stock_prices
        )
        
        # Tool 2: Get stock info
        self.tool_registry.register(
            name="get_stock_info",
            description="Get stock information for a given ticker symbol from local database. Include comprehensive stock data including price, company info, financial metrics, earnings, margins, dividends, balance sheet, ownership, analyst coverage, and risk metrics.",
            input_schema=create_ticker_tool_schema(),
            handler=self.get_stock_info
        )
        
        # Tool 3: Get news
        self.tool_registry.register(
            name="get_yahoo_finance_news",
            description="Get news for a given ticker symbol from local database.",
            input_schema=create_ticker_tool_schema(),
            handler=self.get_yahoo_finance_news
        )
        
        # Tool 4: Get stock actions
        self.tool_registry.register(
            name="get_stock_actions",
            description="Get stock dividends and stock splits for a given ticker symbol from local database.",
            input_schema=create_ticker_tool_schema(),
            handler=self.get_stock_actions
        )
        
        # Tool 5: Get financial statement
        self.tool_registry.register(
            name="get_financial_statement",
            description="Get financial statement for a given ticker symbol from local database. You can choose from the following financial statement types: income_stmt, quarterly_income_stmt, balance_sheet, quarterly_balance_sheet, cashflow, quarterly_cashflow.",
            input_schema=create_ticker_tool_schema(
                additional_required=["financial_type"]
            ),
            handler=self.get_financial_statement
        )
        
        # Tool 6: Get holder info
        self.tool_registry.register(
            name="get_holder_info",
            description="Get holder information for a given ticker symbol from local database. You can choose from the following holder types: major_holders, institutional_holders, mutualfund_holders, insider_transactions, insider_purchases, insider_roster_holders.",
            input_schema=create_ticker_tool_schema(
                additional_required=["holder_type"]
            ),
            handler=self.get_holder_info
        )
        
        # Tool 7: Get option expiration dates
        self.tool_registry.register(
            name="get_option_expiration_dates",
            description="Fetch the available options expiration dates for a given ticker symbol from local database.",
            input_schema=create_ticker_tool_schema(),
            handler=self.get_option_expiration_dates
        )
        
        # Tool 8: Get option chain
        self.tool_registry.register(
            name="get_option_chain",
            description="Fetch the option chain for a given ticker symbol, expiration date, and option type from local database.",
            input_schema=create_ticker_tool_schema(
                additional_required=["expiration_date", "option_type"]
            ),
            handler=self.get_option_chain
        )
        
        # Tool 9: Get recommendations
        self.tool_registry.register(
            name="get_recommendations",
            description="Get recommendations or upgrades/downgrades for a given ticker symbol from local database. You can also specify the number of months back to get upgrades/downgrades for, default is 12.",
            input_schema=create_ticker_tool_schema(
                additional_required=["recommendation_type"],
                additional_optional={
                    "months_back": {
                        "type": "integer",
                        "description": "The number of months back to get upgrades/downgrades for, default is 12.",
                        "default": 12
                    }
                }
            ),
            handler=self.get_recommendations
        )
    
    async def list_tools(self):
        """List all available tools"""
        return self.tool_registry.get_tool_definitions()
    
    async def call_tool(self, name: str, arguments: dict):
        """Handle tool calls using the registry"""
        return await self.tool_registry.call_tool(name, arguments)
    
    # Tool handlers
    async def get_historical_stock_prices(self, args: dict):
        """Get historical stock prices"""
        ticker = args["ticker"]
        period = args.get("period", "1mo")
        interval = args.get("interval", "1d")
        
        data = self.db.get_historical_prices(ticker, period, interval)
        if not data:
            return self.create_text_response(f"No historical price data found for ticker: {ticker}")
        
        return self.create_json_response(data)
    
    async def get_stock_info(self, args: dict):
        """Get stock information"""
        ticker = args["ticker"]
        
        data = self.db.get_stock_info(ticker)
        if not data:
            return self.create_text_response(f"No stock information found for ticker: {ticker}")
        
        return self.create_json_response(data)
    
    async def get_yahoo_finance_news(self, args: dict):
        """Get news for ticker"""
        ticker = args["ticker"]
        
        data = self.db.get_news(ticker)
        if not data:
            return self.create_text_response(f"No news found for ticker: {ticker}")
        
        return self.create_json_response(data)
    
    async def get_stock_actions(self, args: dict):
        """Get stock actions"""
        ticker = args["ticker"]
        
        data = self.db.get_stock_actions(ticker)
        if not data["dividends"] and not data["splits"]:
            return self.create_text_response(f"No stock actions found for ticker: {ticker}")
        
        return self.create_json_response(data)
    
    async def get_financial_statement(self, args: dict):
        """Get financial statement"""
        ticker = args["ticker"]
        financial_type = args["financial_type"]
        
        data = self.db.get_financial_statement(ticker, financial_type)
        if not data:
            return self.create_text_response(f"No {financial_type} data found for ticker: {ticker}")
        
        return self.create_json_response(data)
    
    async def get_holder_info(self, args: dict):
        """Get holder information"""
        ticker = args["ticker"]
        holder_type = args["holder_type"]
        
        data = self.db.get_holder_info(ticker, holder_type)
        if not data:
            return self.create_text_response(f"No {holder_type} data found for ticker: {ticker}")
        
        return self.create_json_response(data)
    
    async def get_option_expiration_dates(self, args: dict):
        """Get option expiration dates"""
        ticker = args["ticker"]
        
        data = self.db.get_option_expiration_dates(ticker)
        if not data:
            return self.create_text_response(f"No option expiration dates found for ticker: {ticker}")
        
        return self.create_json_response(data)
    
    async def get_option_chain(self, args: dict):
        """Get option chain"""
        ticker = args["ticker"]
        expiration_date = args["expiration_date"]
        option_type = args["option_type"]
        
        data = self.db.get_option_chain(ticker, expiration_date, option_type)
        if not data:
            return self.create_text_response(f"No option chain data found for {ticker} {option_type} expiring {expiration_date}")
        
        return self.create_json_response(data)
    
    async def get_recommendations(self, args: dict):
        """Get recommendations"""
        ticker = args["ticker"]
        recommendation_type = args["recommendation_type"]
        months_back = args.get("months_back", 12)
        
        data = self.db.get_recommendations(ticker, recommendation_type)
        if not data:
            return self.create_text_response(f"No {recommendation_type} data found for ticker: {ticker}")
        
        return self.create_json_response(data)


async def main():
    """Main entry point"""
    server = YFinanceMCPServer()
    await server.run()


if __name__ == "__main__":
    asyncio.run(main())