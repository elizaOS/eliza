#!/usr/bin/env python3
"""
Trenches Chat Dataset - Interactive Explorer
Explore specific aspects of the Trenches Discord chat dataset
"""

import json
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns
from datetime import datetime, timedelta
from pathlib import Path
import argparse

# Set style for better plots
sns.set_style("whitegrid")
plt.rcParams['figure.figsize'] = (14, 8)

from load_dataset import TrenchesDataset

def explore_token_detailed(dataset: TrenchesDataset, token_symbol: str):
    """Generate detailed analysis for a specific token"""
    # Check if trying to analyze native token
    if token_symbol.upper() == 'AI16Z':
        print(f"\n❌ AI16Z is the native token and has been filtered from this dataset.")
        print("Please analyze a different token.")
        return
    
    print(f"\n🔍 Detailed Analysis for {token_symbol}")
    print("=" * 60)
    
    # Get all calls for this token
    token_calls = dataset.get_token_calls(token_symbol)
    
    if len(token_calls) == 0:
        print(f"No calls found for {token_symbol}")
        return
    
    print(f"Total calls: {len(token_calls)}")
    print(f"Date range: {token_calls['datetime'].min()} to {token_calls['datetime'].max()}")
    
    # Sentiment breakdown
    print(f"\nSentiment breakdown:")
    sentiment_counts = token_calls['sentiment'].value_counts()
    for sentiment, count in sentiment_counts.items():
        print(f"  {sentiment}: {count} ({count/len(token_calls)*100:.1f}%)")
    
    # Conviction breakdown
    print(f"\nConviction breakdown:")
    conviction_counts = token_calls['conviction'].value_counts()
    for conviction, count in conviction_counts.items():
        print(f"  {conviction}: {count} ({count/len(token_calls)*100:.1f}%)")
    
    # Top callers
    print(f"\nTop 10 callers for {token_symbol}:")
    top_callers = token_calls['username'].value_counts().head(10)
    for username, count in top_callers.items():
        print(f"  {username}: {count} calls")
    
    # Create visualizations
    fig, ((ax1, ax2), (ax3, ax4)) = plt.subplots(2, 2, figsize=(16, 12))
    
    # 1. Calls over time
    calls_by_date = token_calls.groupby(token_calls['datetime'].dt.date).size()
    calls_by_date.plot(ax=ax1, kind='bar', color='steelblue')
    ax1.set_title(f"{token_symbol} Calls Over Time")
    ax1.set_xlabel("Date")
    ax1.set_ylabel("Number of Calls")
    ax1.tick_params(axis='x', rotation=45)
    
    # 2. Sentiment distribution
    sentiment_counts.plot(ax=ax2, kind='pie', autopct='%1.1f%%')
    ax2.set_title(f"{token_symbol} Sentiment Distribution")
    ax2.set_ylabel("")
    
    # 3. Hourly distribution
    token_calls['hour'] = token_calls['datetime'].dt.hour
    hourly_dist = token_calls['hour'].value_counts().sort_index()
    hourly_dist.plot(ax=ax3, kind='bar', color='darkgreen')
    ax3.set_title(f"{token_symbol} Calls by Hour of Day (UTC)")
    ax3.set_xlabel("Hour")
    ax3.set_ylabel("Number of Calls")
    
    # 4. Top callers
    top_callers.plot(ax=ax4, kind='barh', color='coral')
    ax4.set_title(f"Top 10 Callers for {token_symbol}")
    ax4.set_xlabel("Number of Calls")
    ax4.invert_yaxis()
    
    plt.tight_layout()
    plt.savefig(f'analysis_{token_symbol}.png', dpi=300, bbox_inches='tight')
    plt.close()
    print(f"\n✅ Saved detailed analysis to: analysis_{token_symbol}.png")

def explore_user_detailed(dataset: TrenchesDataset, username: str):
    """Generate detailed analysis for a specific user"""
    print(f"\n👤 Detailed Analysis for {username}")
    print("=" * 60)
    
    # Get user stats
    users = dataset.load_users()
    user = users[users['username'] == username]
    
    if len(user) == 0:
        print(f"User {username} not found")
        return
    
    user = user.iloc[0]
    
    # Get all calls by this user
    user_calls = dataset.get_user_calls(user['user_id'])
    
    # Calculate unique tokens
    unique_tokens = user_calls['token_mentioned'].nunique()
    
    print(f"Total calls: {user['total_calls']}")
    print(f"Unique tokens called: {unique_tokens}")
    print(f"Trust score: {user['trust_score']:.2f}")
    print(f"Success rate: {user['success_rate']:.2f}%")
    print(f"Average P/L: {user['avg_profit_loss']:.2f}%")
    
    # Check if user meets diversity criteria
    if unique_tokens < 5:
        print(f"\n⚠️  Warning: User has called fewer than 5 different tokens ({unique_tokens})")
        print("   This user would not qualify for leaderboards due to lack of token diversity.")
    
    if user['total_calls'] < 10:
        print(f"\n⚠️  Warning: User has made fewer than 10 calls ({user['total_calls']})")
    
    print(f"\nTokens called: {len(user['tokens_called'])}")
    print(f"Most frequent tokens:")
    token_counts = user_calls['token_mentioned'].value_counts().head(10)
    for token, count in token_counts.items():
        percentage = (count / user['total_calls']) * 100
        print(f"  {token}: {count} calls ({percentage:.1f}% of total)")
    
    # Check for potential duplicate spam
    print("\nChecking for duplicate call patterns...")
    duplicates = 0
    for (token, sentiment), group in user_calls.groupby(['token_mentioned', 'sentiment']):
        if len(group) > 1:
            # Check for calls within 1 hour
            group = group.sort_values('timestamp')
            for i in range(1, len(group)):
                if group.iloc[i]['timestamp'] - group.iloc[i-1]['timestamp'] < 3600000:  # 1 hour
                    duplicates += 1
    
    if duplicates > 0:
        print(f"⚠️  Found {duplicates} potential duplicate calls (same token/sentiment within 1 hour)")
    else:
        print("✅ No duplicate call patterns detected")
    
    # Create visualizations
    fig, ((ax1, ax2), (ax3, ax4)) = plt.subplots(2, 2, figsize=(16, 12))
    
    # 1. Calls over time
    calls_by_date = user_calls.groupby(user_calls['datetime'].dt.date).size()
    calls_by_date.plot(ax=ax1, kind='line', marker='o', color='steelblue')
    ax1.set_title(f"{username}'s Call Activity Over Time")
    ax1.set_xlabel("Date")
    ax1.set_ylabel("Number of Calls")
    ax1.grid(True, alpha=0.3)
    
    # 2. Sentiment distribution
    sentiment_counts = user_calls['sentiment'].value_counts()
    sentiment_counts.plot(ax=ax2, kind='pie', autopct='%1.1f%%')
    ax2.set_title(f"{username}'s Sentiment Distribution")
    ax2.set_ylabel("")
    
    # 3. Conviction distribution
    conviction_counts = user_calls['conviction'].value_counts()
    conviction_counts.plot(ax=ax3, kind='bar', color='darkgreen')
    ax3.set_title(f"{username}'s Conviction Levels")
    ax3.set_xlabel("Conviction")
    ax3.set_ylabel("Number of Calls")
    
    # 4. Top tokens
    token_counts.head(10).plot(ax=ax4, kind='barh', color='coral')
    ax4.set_title(f"{username}'s Top 10 Tokens")
    ax4.set_xlabel("Number of Calls")
    ax4.invert_yaxis()
    
    plt.tight_layout()
    plt.savefig(f'analysis_user_{username.replace(" ", "_")}.png', dpi=300, bbox_inches='tight')
    plt.close()
    print(f"\n✅ Saved user analysis to: analysis_user_{username.replace(' ', '_')}.png")

def explore_time_period(dataset: TrenchesDataset, start_date: str, end_date: str):
    """Analyze calls within a specific time period"""
    print(f"\n📅 Analysis for period: {start_date} to {end_date}")
    print("=" * 60)
    
    # Convert dates
    start = pd.to_datetime(start_date)
    end = pd.to_datetime(end_date)
    
    # Filter calls
    calls = dataset.load_calls()
    period_calls = calls[(calls['datetime'] >= start) & (calls['datetime'] <= end)]
    
    print(f"Total calls in period: {len(period_calls)}")
    print(f"Daily average: {len(period_calls) / ((end - start).days + 1):.1f}")
    
    # Top tokens in period
    print(f"\nTop 10 tokens in this period:")
    top_tokens = period_calls['token_mentioned'].value_counts().head(10)
    for token, count in top_tokens.items():
        print(f"  {token}: {count} calls")
    
    # Create visualizations
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(16, 6))
    
    # 1. Daily call volume
    daily_calls = period_calls.groupby(period_calls['datetime'].dt.date).size()
    daily_calls.plot(ax=ax1, kind='bar', color='steelblue')
    ax1.set_title(f"Daily Call Volume ({start_date} to {end_date})")
    ax1.set_xlabel("Date")
    ax1.set_ylabel("Number of Calls")
    ax1.tick_params(axis='x', rotation=45)
    
    # 2. Token distribution
    top_tokens.plot(ax=ax2, kind='bar', color='darkgreen')
    ax2.set_title(f"Top 10 Tokens ({start_date} to {end_date})")
    ax2.set_xlabel("Token")
    ax2.set_ylabel("Number of Calls")
    ax2.tick_params(axis='x', rotation=45)
    
    plt.tight_layout()
    plt.savefig(f'analysis_period_{start_date}_{end_date}.png', dpi=300, bbox_inches='tight')
    plt.close()
    print(f"\n✅ Saved period analysis to: analysis_period_{start_date}_{end_date}.png")

def main():
    parser = argparse.ArgumentParser(description='Trenches Dataset Interactive Explorer')
    parser.add_argument('--token', type=str, help='Analyze specific token (e.g., "ai16z")')
    parser.add_argument('--user', type=str, help='Analyze specific user (e.g., "Pmore")')
    parser.add_argument('--start-date', type=str, help='Start date for period analysis (YYYY-MM-DD)')
    parser.add_argument('--end-date', type=str, help='End date for period analysis (YYYY-MM-DD)')
    parser.add_argument('--data-dir', type=str, default='../../data', help='Path to data directory')
    
    args = parser.parse_args()
    
    print("🚀 Trenches Dataset Interactive Explorer")
    print("=" * 60)
    
    # Initialize dataset
    dataset = TrenchesDataset(args.data_dir)
    
    # Load data
    print("Loading dataset...")
    dataset.load_messages()
    dataset.load_calls()
    dataset.load_tokens()
    dataset.load_users()
    
    # Run requested analysis
    if args.token:
        explore_token_detailed(dataset, args.token.upper())
    
    if args.user:
        explore_user_detailed(dataset, args.user)
    
    if args.start_date and args.end_date:
        explore_time_period(dataset, args.start_date, args.end_date)
    
    if not any([args.token, args.user, args.start_date]):
        print("\nUsage examples:")
        print("  python interactive_explorer.py --token ai16z")
        print("  python interactive_explorer.py --user Pmore")
        print("  python interactive_explorer.py --start-date 2024-12-01 --end-date 2024-12-31")
        print("\nYou can also combine options to run multiple analyses at once.")

if __name__ == "__main__":
    main() 