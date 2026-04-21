#!/usr/bin/env python3
"""
Trenches Chat Dataset - Python Example
Load and explore the Trenches Discord chat dataset
"""

import json
import pandas as pd
from datetime import datetime
import matplotlib.pyplot as plt
import seaborn as sns
from pathlib import Path

# Set style for better plots
sns.set_style("whitegrid")
plt.rcParams['figure.figsize'] = (12, 6)

# Native token to filter out
NATIVE_TOKEN = 'AI16Z'

class TrenchesDataset:
    """Class to load and interact with the Trenches chat dataset"""
    
    def __init__(self, data_dir: str = "../../data"):
        """Initialize the dataset loader
        
        Args:
            data_dir: Path to the data directory
        """
        self.data_dir = Path(data_dir)
        self.messages = None
        self.calls = None
        self.tokens = None
        self.users = None
        
    def load_messages(self) -> pd.DataFrame:
        """Load all chat messages"""
        with open(self.data_dir / "messages.json", 'r') as f:
            self.messages = pd.DataFrame(json.load(f))
        
        # Convert timestamps to datetime
        self.messages['datetime'] = pd.to_datetime(self.messages['timestamp'], unit='ms')
        print(f"Loaded {len(self.messages)} messages")
        return self.messages
    
    def load_calls(self) -> pd.DataFrame:
        """Load all trading calls (excluding native token)"""
        with open(self.data_dir / "calls.json", 'r') as f:
            calls_data = json.load(f)
        
        self.calls = pd.DataFrame(calls_data)
        
        # Filter out native token
        original_count = len(self.calls)
        self.calls = self.calls[self.calls['token_mentioned'].str.upper() != NATIVE_TOKEN]
        filtered_count = original_count - len(self.calls)
        
        # Convert timestamps to datetime
        self.calls['datetime'] = pd.to_datetime(self.calls['timestamp'], unit='ms')
        
        # Filter duplicate calls (same user, token, sentiment within 1 hour)
        print("Filtering duplicate calls (same token/sentiment within 1 hour)...")
        before_dedup = len(self.calls)
        
        # Sort by timestamp to keep the first occurrence
        self.calls = self.calls.sort_values('timestamp')
        
        # Create a key for deduplication
        self.calls['dedup_key'] = (
            self.calls['user_id'] + '_' + 
            self.calls['token_mentioned'] + '_' + 
            self.calls['sentiment']
        )
        
        # Group by dedup key and filter calls within 1 hour of each other
        filtered_calls = []
        for key, group in self.calls.groupby('dedup_key'):
            if len(group) == 1:
                filtered_calls.append(group.index[0])
            else:
                # Keep first call, then only calls that are >1 hour after previous kept call
                last_kept_time = group.iloc[0]['timestamp']
                filtered_calls.append(group.index[0])
                
                for idx in group.index[1:]:
                    if group.loc[idx, 'timestamp'] - last_kept_time > 3600000:  # 1 hour in ms
                        filtered_calls.append(idx)
                        last_kept_time = group.loc[idx, 'timestamp']
        
        self.calls = self.calls.loc[filtered_calls]
        self.calls = self.calls.drop('dedup_key', axis=1)
        
        dedup_filtered = before_dedup - len(self.calls)
        
        print(f"Loaded {len(self.calls)} trading calls (filtered {filtered_count} {NATIVE_TOKEN} calls, {dedup_filtered} duplicates)")
        return self.calls
    
    def load_tokens(self) -> pd.DataFrame:
        """Load token manifest (excluding native token)"""
        with open(self.data_dir / "tokens.json", 'r') as f:
            tokens_data = json.load(f)
        
        self.tokens = pd.DataFrame(tokens_data)
        
        # Filter out native token
        original_count = len(self.tokens)
        self.tokens = self.tokens[self.tokens['symbol'].str.upper() != NATIVE_TOKEN]
        
        print(f"Loaded {len(self.tokens)} unique tokens (excluding {NATIVE_TOKEN})")
        return self.tokens
    
    def load_users(self) -> pd.DataFrame:
        """Load user manifest"""
        # Try to load users with metrics first, fall back to regular users.json
        try:
            with open(self.data_dir / "users_with_metrics.json", 'r') as f:
                self.users = pd.DataFrame(json.load(f))
        except FileNotFoundError:
            with open(self.data_dir / "users.json", 'r') as f:
                self.users = pd.DataFrame(json.load(f))
        
        print(f"Loaded {len(self.users)} users")
        return self.users
    
    def load_price_history(self, token_address: str) -> pd.DataFrame:
        """Load price history for a specific token
        
        Args:
            token_address: The token's contract address
            
        Returns:
            DataFrame with price history
        """
        # Sanitize address for filename (replace slashes with underscores)
        sanitized_address = token_address.replace('/', '_')
        filepath = self.data_dir / "price_history" / f"{sanitized_address}.json"
        if not filepath.exists():
            raise FileNotFoundError(f"Price history not found for {token_address}")
        
        with open(filepath, 'r') as f:
            data = json.load(f)
        
        df = pd.DataFrame(data['price_history'])
        df['datetime'] = pd.to_datetime(df['timestamp'], unit='ms')
        return df
    
    def get_token_calls(self, token_symbol: str) -> pd.DataFrame:
        """Get all calls for a specific token
        
        Args:
            token_symbol: The token symbol (e.g., 'SOL', 'FWOG')
            
        Returns:
            DataFrame with calls for that token
        """
        # Don't allow querying native token
        if token_symbol.upper() == NATIVE_TOKEN:
            print(f"Note: {NATIVE_TOKEN} is filtered from this dataset")
            return pd.DataFrame()
        
        if self.calls is None:
            self.load_calls()
        
        return self.calls[self.calls['token_mentioned'] == token_symbol]
    
    def get_user_calls(self, user_id: str) -> pd.DataFrame:
        """Get all calls by a specific user (excluding native token)
        
        Args:
            user_id: The Discord user ID
            
        Returns:
            DataFrame with calls by that user
        """
        if self.calls is None:
            self.load_calls()
        
        return self.calls[self.calls['user_id'] == user_id]
    
    def plot_calls_timeline(self, token_symbol: str = None):
        """Plot timeline of calls
        
        Args:
            token_symbol: Optional token to filter by
        """
        if self.calls is None:
            self.load_calls()
        
        # Don't allow plotting native token
        if token_symbol and token_symbol.upper() == NATIVE_TOKEN:
            print(f"Note: {NATIVE_TOKEN} is filtered from this dataset")
            return
        
        calls = self.calls if token_symbol is None else self.get_token_calls(token_symbol)
        
        # Group by date
        calls_by_date = calls.groupby(calls['datetime'].dt.date).size()
        
        plt.figure(figsize=(14, 6))
        calls_by_date.plot(kind='bar')
        plt.title(f"Trading Calls Over Time{f' for {token_symbol}' if token_symbol else f' (excluding {NATIVE_TOKEN})'}")
        plt.xlabel("Date")
        plt.ylabel("Number of Calls")
        plt.xticks(rotation=45)
        plt.tight_layout()
        # plt.show()  # Commented out to save instead of display
    
    def plot_sentiment_distribution(self):
        """Plot distribution of call sentiments (excluding native token)"""
        if self.calls is None:
            self.load_calls()
        
        sentiment_counts = self.calls['sentiment'].value_counts()
        
        plt.figure(figsize=(8, 6))
        sentiment_counts.plot(kind='pie', autopct='%1.1f%%')
        plt.title(f"Distribution of Call Sentiments (excluding {NATIVE_TOKEN})")
        plt.ylabel("")
        # plt.show()  # Commented out to save instead of display
    
    def plot_top_tokens(self, n: int = 20):
        """Plot most mentioned tokens (excluding native token)
        
        Args:
            n: Number of top tokens to show
        """
        if self.tokens is None:
            self.load_tokens()
        
        top_tokens = self.tokens.nlargest(n, 'call_count')
        
        plt.figure(figsize=(12, 8))
        plt.barh(top_tokens['symbol'], top_tokens['call_count'])
        plt.xlabel("Number of Calls")
        plt.title(f"Top {n} Most Mentioned Tokens (excluding {NATIVE_TOKEN})")
        plt.gca().invert_yaxis()
        plt.tight_layout()
        # plt.show()  # Commented out to save instead of display
    
    def plot_user_performance(self, n: int = 20):
        """Plot top performing users
        
        Args:
            n: Number of top users to show
        """
        if self.users is None:
            self.load_users()
        
        if self.calls is None:
            self.load_calls()
        
        # Calculate unique tokens per user from calls data
        user_token_diversity = self.calls.groupby('user_id')['token_mentioned'].nunique()
        
        # Filter users with at least 5 different tokens and 10+ calls
        diverse_users = user_token_diversity[user_token_diversity >= 10].index
        active_users = self.users[
            (self.users['user_id'].isin(diverse_users)) & 
            (self.users['success_rate'] > 0)
        ]
        
        print(f"Filtered to {len(active_users)} users with 5+ different tokens and 10+ calls")
        
        # Get top users by success rate for left chart
        top_by_success = active_users.nlargest(n, 'success_rate')
        
        # Get most active users for right chart (by total calls)
        top_by_calls = active_users.nlargest(n, 'total_calls')
        
        fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(16, 6))
        
        # Success rates (left)
        ax1.barh(top_by_success['username'], top_by_success['success_rate'])
        ax1.set_xlabel("Success Rate (%)")
        ax1.set_title(f"Top {n} Users by Success Rate")
        ax1.invert_yaxis()
        
        # Most active users with their success rates (right)
        ax2.barh(top_by_calls['username'], top_by_calls['success_rate'])
        ax2.set_xlabel("Success Rate (%)")
        ax2.set_title(f"Top {n} Most Active Users - Success Rate")
        ax2.invert_yaxis()
        
        plt.tight_layout()
        # plt.show()  # Commented out to save instead of display

def main():
    """Example usage of the dataset"""
    print(f"🚀 Loading Trenches Chat Dataset (filtering {NATIVE_TOKEN})...")
    
    # Initialize dataset
    dataset = TrenchesDataset()
    
    # Load all data
    messages = dataset.load_messages()
    calls = dataset.load_calls()
    tokens = dataset.load_tokens()
    users = dataset.load_users()
    
    print("\n📊 Dataset Statistics:")
    print(f"Date range: {messages['datetime'].min()} to {messages['datetime'].max()}")
    print(f"Total messages: {len(messages):,}")
    print(f"Messages that are calls: {messages['is_call'].sum():,}")
    print(f"Total unique users: {messages['user_id'].nunique():,}")
    print(f"Users who made calls: {len(users):,}")
    print(f"Unique tokens mentioned: {len(tokens):,} (excluding {NATIVE_TOKEN})")
    
    print("\n📈 Top 10 Most Active Users:")
    top_callers = users.nlargest(10, 'total_calls')[['username', 'total_calls', 'success_rate']]
    print(top_callers.to_string(index=False))
    
    print(f"\n🪙 Top 10 Most Mentioned Tokens (excluding {NATIVE_TOKEN}):")
    top_tokens = tokens.nlargest(10, 'call_count')[['symbol', 'call_count', 'chain']]
    print(top_tokens.to_string(index=False))
    
    print("\n📊 Call Sentiment Distribution:")
    print(calls['sentiment'].value_counts())
    
    print("\n💪 Call Conviction Distribution:")
    print(calls['conviction'].value_counts())
    
    # Example: Load price history for a specific token
    if len(tokens) > 0:
        sample_token = tokens.iloc[0]
        print(f"\n📈 Loading price history for {sample_token['symbol']}...")
        try:
            price_history = dataset.load_price_history(sample_token['address'])
            print(f"Found {len(price_history)} price points")
            print(f"Price range: ${price_history['close'].min():.6f} - ${price_history['close'].max():.6f}")
        except FileNotFoundError:
            print("Price history not found for this token")
    
    # Generate some plots
    print("\n📊 Generating visualizations...")
    
    # Save visualizations as files
    dataset.plot_calls_timeline()
    plt.savefig('visualization_calls_timeline.png', dpi=300, bbox_inches='tight')
    plt.close()
    print("✅ Saved: visualization_calls_timeline.png")
    
    dataset.plot_sentiment_distribution()
    plt.savefig('visualization_sentiment_distribution.png', dpi=300, bbox_inches='tight')
    plt.close()
    print("✅ Saved: visualization_sentiment_distribution.png")
    
    dataset.plot_top_tokens()
    plt.savefig('visualization_top_tokens.png', dpi=300, bbox_inches='tight')
    plt.close()
    print("✅ Saved: visualization_top_tokens.png")
    
    dataset.plot_user_performance()
    plt.savefig('visualization_user_performance.png', dpi=300, bbox_inches='tight')
    plt.close()
    print("✅ Saved: visualization_user_performance.png")
    
    print("\n🎉 All visualizations saved! Check the current directory for PNG files.")

if __name__ == "__main__":
    main() 