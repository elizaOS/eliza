#!/usr/bin/env python3
"""
Trenches Chat Dataset - Comprehensive Analysis
Consolidates all analysis scripts into one comprehensive tool
"""

import json
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns
from datetime import datetime, timedelta
from pathlib import Path
import argparse
import warnings
warnings.filterwarnings('ignore')

# Set style for better plots
sns.set_style("whitegrid")
plt.rcParams['figure.figsize'] = (14, 8)

# Import the dataset loader
from load_dataset import TrenchesDataset

class ComprehensiveAnalyzer:
    """Comprehensive analyzer for Trenches dataset"""
    
    def __init__(self, data_dir: str = "../../data"):
        self.dataset = TrenchesDataset(data_dir)
        self.data_dir = Path(data_dir)
        self.figures = []
        
    def load_all_data(self):
        """Load all dataset components"""
        print("📊 Loading Trenches Chat Dataset...")
        self.dataset.load_messages()
        self.dataset.load_calls()
        self.dataset.load_tokens()
        self.dataset.load_users()
        
        # Load additional metrics if available
        try:
            with open(self.data_dir / "calculated_success_metrics.json", 'r') as f:
                self.calculated_metrics = pd.DataFrame(json.load(f))
        except:
            self.calculated_metrics = None
            
        try:
            with open(self.data_dir / "realistic_success_metrics.json", 'r') as f:
                self.realistic_metrics = pd.DataFrame(json.load(f))
        except:
            self.realistic_metrics = None
            
    def dataset_overview(self):
        """Generate dataset overview statistics"""
        print("\n📊 DATASET OVERVIEW")
        print("=" * 80)
        
        messages = self.dataset.messages
        calls = self.dataset.calls
        tokens = self.dataset.tokens
        users = self.dataset.users
        
        print(f"Date range: {messages['datetime'].min()} to {messages['datetime'].max()}")
        print(f"Total messages: {len(messages):,}")
        print(f"Messages that are calls: {messages['is_call'].sum():,}")
        print(f"Total unique users: {messages['user_id'].nunique():,}")
        print(f"Users who made calls: {len(users):,}")
        print(f"Unique tokens mentioned: {len(tokens):,}")
        
        print("\n📊 Call Statistics:")
        print(f"Total trading calls: {len(calls):,}")
        print(f"Average calls per user: {len(calls) / len(users):.1f}")
        print(f"Average calls per token: {len(calls) / len(tokens):.1f}")
        
        # Sentiment breakdown
        print("\n📊 Sentiment Distribution:")
        sentiment_counts = calls['sentiment'].value_counts()
        for sentiment, count in sentiment_counts.items():
            print(f"  {sentiment}: {count:,} ({count/len(calls)*100:.1f}%)")
        
        # Conviction breakdown
        print("\n💪 Conviction Distribution:")
        conviction_counts = calls['conviction'].value_counts()
        for conviction, count in conviction_counts.items():
            print(f"  {conviction}: {count:,} ({count/len(calls)*100:.1f}%)")
            
    def worst_performers_analysis(self):
        """Analyze worst performing users"""
        print("\n🚨 WORST PERFORMERS ANALYSIS")
        print("=" * 80)
        
        if self.calculated_metrics is None:
            print("Calculated metrics not available")
            return
            
        df = self.calculated_metrics
        
        # Filter users with at least 10 calls
        qualified_df = df[df['callsWithPriceData'] >= 10].copy()
        
        print(f"Total users with metrics: {len(df)}")
        print(f"Users with 10+ calls with price data: {len(qualified_df)}")
        
        # Worst by success rate
        worst_by_success = qualified_df.nsmallest(20, 'successRate')
        
        print("\n📉 Top 20 Worst Performers by Success Rate (min 10 calls):")
        print("-" * 100)
        print(f"{'Rank':<5} {'Username':<20} {'Success%':<10} {'Avg P/L%':<10} {'Calls':<8} {'Failed':<8}")
        print("-" * 100)
        
        for i, user in enumerate(worst_by_success.itertuples(), 1):
            print(f"{i:<5} {user.username:<20} {user.successRate:>8.1f}% "
                  f"{user.averageProfitLossPercent:>9.1f}% {user.callsWithPriceData:>7} "
                  f"{user.failedCalls:>7}")
                  
    def realistic_worst_performers_analysis(self):
        """Analyze worst performers using realistic metrics"""
        print("\n🚨 REALISTIC WORST PERFORMERS ANALYSIS (1 Hour Min Hold)")
        print("=" * 80)
        
        if self.realistic_metrics is None:
            print("Realistic metrics not available")
            return
            
        df = self.realistic_metrics
        
        print(f"Total users analyzed: {len(df)}")
        print(f"Average success rate: {df['successRate'].mean():.1f}%")
        print(f"Average rug rate: {df['rugRate'].mean():.1f}%")
        
        # Users with <50% success rate
        low_success = df[df['successRate'] < 50].sort_values('successRate')
        
        print(f"\n📉 Users with <50% Success Rate ({len(low_success)} users):")
        print("-" * 100)
        print(f"{'Username':<20} {'Success%':<10} {'Rug%':<8} {'Avg P/L%':<10} {'Calls':<8}")
        print("-" * 100)
        
        for user in low_success.head(20).itertuples():
            print(f"{user.username:<20} {user.successRate:>8.1f}% {user.rugRate:>7.1f}% "
                  f"{user.averageProfitLossPercent:>9.1f}% {user.callsWithPriceData:>7}")
                  
    def performance_distribution_analysis(self):
        """Analyze performance distribution"""
        print("\n📊 PERFORMANCE DISTRIBUTION ANALYSIS")
        print("=" * 80)
        
        if self.calculated_metrics is None:
            print("Calculated metrics not available")
            return
            
        df = self.calculated_metrics
        
        # Success rate buckets
        print("\n📊 Success Rate Distribution:")
        print("-" * 60)
        
        buckets = [
            (0, 40, "0-40%"),
            (40, 50, "40-50%"),
            (50, 60, "50-60%"),
            (60, 70, "60-70%"),
            (70, 80, "70-80%"),
            (80, 90, "80-90%"),
            (90, 100, "90-100%")
        ]
        
        for low, high, label in buckets:
            count = len(df[(df['successRate'] >= low) & (df['successRate'] < high)])
            pct = count / len(df) * 100
            bar = '█' * int(pct / 2)
            print(f"{label}: {count:>4} users ({pct:>5.1f}%) {bar}")
            
        # Key statistics
        print("\n📈 Key Statistics:")
        print("-" * 60)
        print(f"Average success rate: {df['successRate'].mean():.1f}% (±{df['successRate'].std():.1f}%)")
        print(f"Average P/L per call: {df['averageProfitLossPercent'].mean():.1f}%")
        print(f"Users with <50% success: {len(df[df['successRate'] < 50])} ({len(df[df['successRate'] < 50])/len(df)*100:.1f}%)")
        print(f"Users with negative P/L: {len(df[df['averageProfitLossPercent'] < 0])}")
        
    def top_performers_analysis(self):
        """Analyze top performing users"""
        print("\n🏆 TOP PERFORMERS ANALYSIS")
        print("=" * 80)
        
        users = self.dataset.users
        calls = self.dataset.calls
        
        # Calculate token diversity
        user_token_diversity = calls.groupby('user_id')['token_mentioned'].nunique()
        
        # Filter users with diverse portfolios
        diverse_users = user_token_diversity[user_token_diversity >= 5].index
        active_users = users[
            (users['user_id'].isin(diverse_users)) & 
            (users['total_calls'] >= 10) &
            (users['success_rate'] > 0)
        ]
        
        print(f"Users with 5+ tokens and 10+ calls: {len(active_users)}")
        
        # Top by success rate
        print("\n📈 Top 20 Users by Success Rate:")
        print("-" * 80)
        print(f"{'Rank':<5} {'Username':<20} {'Success%':<10} {'Calls':<8} {'Avg P/L%':<10}")
        print("-" * 80)
        
        top_success = active_users.nlargest(20, 'success_rate')
        for i, user in enumerate(top_success.itertuples(), 1):
            print(f"{i:<5} {user.username:<20} {user.success_rate:>8.1f}% "
                  f"{user.total_calls:>7} {user.avg_profit_loss:>9.1f}%")
                  
    def token_analysis(self):
        """Analyze top tokens"""
        print("\n🪙 TOKEN ANALYSIS")
        print("=" * 80)
        
        tokens = self.dataset.tokens
        calls = self.dataset.calls
        
        # Top tokens by call count
        print("\n📊 Top 20 Most Called Tokens:")
        print("-" * 80)
        print(f"{'Rank':<5} {'Symbol':<10} {'Calls':<8} {'Chain':<10} {'Users':<8}")
        print("-" * 80)
        
        top_tokens = tokens.nlargest(20, 'call_count')
        for i, token in enumerate(top_tokens.itertuples(), 1):
            # Count unique users for this token
            unique_users = calls[calls['token_mentioned'] == token.symbol]['user_id'].nunique()
            print(f"{i:<5} {token.symbol:<10} {token.call_count:>7} {token.chain:<10} {unique_users:>7}")
            
    def create_all_visualizations(self):
        """Create all visualizations"""
        print("\n📊 GENERATING VISUALIZATIONS...")
        print("=" * 80)
        
        # 1. Timeline visualization
        self._create_timeline_viz()
        
        # 2. Performance distribution
        self._create_performance_distribution_viz()
        
        # 3. Token analysis visualization
        self._create_token_analysis_viz()
        
        # 4. User performance visualization
        self._create_user_performance_viz()
        
        # 5. Sentiment and conviction visualization
        self._create_sentiment_conviction_viz()
        
        print(f"\n✅ Generated {len(self.figures)} visualizations")
        
    def _create_timeline_viz(self):
        """Create timeline visualization"""
        calls = self.dataset.calls
        
        fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(14, 10))
        
        # Daily call volume
        daily_calls = calls.groupby(calls['datetime'].dt.date).size()
        daily_calls.plot(ax=ax1, kind='bar', color='steelblue')
        ax1.set_title("Daily Trading Call Volume")
        ax1.set_xlabel("Date")
        ax1.set_ylabel("Number of Calls")
        ax1.tick_params(axis='x', rotation=45)
        
        # Hourly distribution
        hourly_calls = calls.groupby(calls['datetime'].dt.hour).size()
        hourly_calls.plot(ax=ax2, kind='bar', color='darkgreen')
        ax2.set_title("Trading Calls by Hour of Day (UTC)")
        ax2.set_xlabel("Hour")
        ax2.set_ylabel("Number of Calls")
        
        plt.tight_layout()
        plt.savefig('comprehensive_timeline.png', dpi=300, bbox_inches='tight')
        plt.close()
        self.figures.append('comprehensive_timeline.png')
        
    def _create_performance_distribution_viz(self):
        """Create performance distribution visualization"""
        if self.calculated_metrics is None:
            return
            
        df = self.calculated_metrics
        
        fig, ((ax1, ax2), (ax3, ax4)) = plt.subplots(2, 2, figsize=(16, 12))
        
        # Success rate distribution
        ax1.hist(df['successRate'], bins=20, color='steelblue', edgecolor='black')
        ax1.axvline(df['successRate'].mean(), color='red', linestyle='--', 
                    label=f'Mean: {df["successRate"].mean():.1f}%')
        ax1.set_xlabel('Success Rate (%)')
        ax1.set_ylabel('Number of Users')
        ax1.set_title('Distribution of Success Rates')
        ax1.legend()
        
        # Average P/L distribution
        ax2.hist(df['averageProfitLossPercent'], bins=20, color='darkgreen', edgecolor='black')
        ax2.axvline(df['averageProfitLossPercent'].mean(), color='red', linestyle='--')
        ax2.set_xlabel('Average P/L (%)')
        ax2.set_ylabel('Number of Users')
        ax2.set_title('Distribution of Average Profit/Loss')
        
        # Success vs P/L scatter
        scatter = ax3.scatter(df['successRate'], df['averageProfitLossPercent'], 
                             c=df['callsWithPriceData'], cmap='viridis', alpha=0.6)
        ax3.set_xlabel('Success Rate (%)')
        ax3.set_ylabel('Average P/L (%)')
        ax3.set_title('Success Rate vs Average P/L')
        plt.colorbar(scatter, ax=ax3, label='Calls')
        
        # Performance by volume
        bins = [0, 10, 25, 50, 100, float('inf')]
        labels = ['1-10', '11-25', '26-50', '51-100', '100+']
        df['volume_bin'] = pd.cut(df['callsWithPriceData'], bins=bins, labels=labels)
        volume_stats = df.groupby('volume_bin')['successRate'].mean()
        volume_stats.plot(kind='bar', ax=ax4, color='coral')
        ax4.set_xlabel('Number of Calls')
        ax4.set_ylabel('Average Success Rate (%)')
        ax4.set_title('Success Rate by Call Volume')
        ax4.set_xticklabels(labels, rotation=45)
        
        plt.tight_layout()
        plt.savefig('comprehensive_performance.png', dpi=300, bbox_inches='tight')
        plt.close()
        self.figures.append('comprehensive_performance.png')
        
    def _create_token_analysis_viz(self):
        """Create token analysis visualization"""
        tokens = self.dataset.tokens
        
        fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(16, 8))
        
        # Top tokens by calls
        top_tokens = tokens.nlargest(15, 'call_count')
        ax1.barh(top_tokens['symbol'], top_tokens['call_count'], color='steelblue')
        ax1.set_xlabel('Number of Calls')
        ax1.set_title('Top 15 Most Called Tokens')
        ax1.invert_yaxis()
        
        # Chain distribution
        chain_dist = tokens.groupby('chain').size()
        chain_dist.plot(kind='pie', ax=ax2, autopct='%1.1f%%')
        ax2.set_title('Token Distribution by Chain')
        ax2.set_ylabel('')
        
        plt.tight_layout()
        plt.savefig('comprehensive_tokens.png', dpi=300, bbox_inches='tight')
        plt.close()
        self.figures.append('comprehensive_tokens.png')
        
    def _create_user_performance_viz(self):
        """Create user performance visualization"""
        users = self.dataset.users
        calls = self.dataset.calls
        
        # Filter active users
        user_token_diversity = calls.groupby('user_id')['token_mentioned'].nunique()
        diverse_users = user_token_diversity[user_token_diversity >= 5].index
        active_users = users[
            (users['user_id'].isin(diverse_users)) & 
            (users['total_calls'] >= 10)
        ]
        
        fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(16, 8))
        
        # Top by success rate
        top_success = active_users.nlargest(15, 'success_rate')
        ax1.barh(top_success['username'], top_success['success_rate'], color='darkgreen')
        ax1.set_xlabel('Success Rate (%)')
        ax1.set_title('Top 15 Users by Success Rate (5+ tokens, 10+ calls)')
        ax1.invert_yaxis()
        
        # Top by total calls
        top_active = active_users.nlargest(15, 'total_calls')
        bars = ax2.barh(top_active['username'], top_active['total_calls'], color='coral')
        ax2.set_xlabel('Total Calls')
        ax2.set_title('Top 15 Most Active Users')
        ax2.invert_yaxis()
        
        # Add success rate labels
        for i, (bar, user) in enumerate(zip(bars, top_active.itertuples())):
            ax2.text(bar.get_width() + 5, bar.get_y() + bar.get_height()/2, 
                    f'{user.success_rate:.0f}%', va='center')
        
        plt.tight_layout()
        plt.savefig('comprehensive_users.png', dpi=300, bbox_inches='tight')
        plt.close()
        self.figures.append('comprehensive_users.png')
        
    def _create_sentiment_conviction_viz(self):
        """Create sentiment and conviction visualization"""
        calls = self.dataset.calls
        
        fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 6))
        
        # Sentiment distribution
        sentiment_counts = calls['sentiment'].value_counts()
        sentiment_counts.plot(kind='pie', ax=ax1, autopct='%1.1f%%', colors=['lightgreen', 'lightcoral', 'lightblue'])
        ax1.set_title('Call Sentiment Distribution')
        ax1.set_ylabel('')
        
        # Conviction distribution
        conviction_counts = calls['conviction'].value_counts()
        conviction_counts.plot(kind='bar', ax=ax2, color='steelblue')
        ax2.set_title('Call Conviction Distribution')
        ax2.set_xlabel('Conviction Level')
        ax2.set_ylabel('Number of Calls')
        ax2.set_xticklabels(ax2.get_xticklabels(), rotation=45)
        
        plt.tight_layout()
        plt.savefig('comprehensive_sentiment.png', dpi=300, bbox_inches='tight')
        plt.close()
        self.figures.append('comprehensive_sentiment.png')
        
    def generate_summary_report(self):
        """Generate a summary report"""
        print("\n📋 GENERATING SUMMARY REPORT...")
        
        report = {
            'generated_at': datetime.now().isoformat(),
            'dataset_stats': {
                'total_messages': len(self.dataset.messages),
                'total_calls': len(self.dataset.calls),
                'unique_users': len(self.dataset.users),
                'unique_tokens': len(self.dataset.tokens),
                'date_range': {
                    'start': str(self.dataset.messages['datetime'].min()),
                    'end': str(self.dataset.messages['datetime'].max())
                }
            },
            'sentiment_distribution': self.dataset.calls['sentiment'].value_counts().to_dict(),
            'conviction_distribution': self.dataset.calls['conviction'].value_counts().to_dict(),
            'visualizations_generated': self.figures
        }
        
        if self.calculated_metrics is not None:
            report['performance_metrics'] = {
                'average_success_rate': float(self.calculated_metrics['successRate'].mean()),
                'average_profit_loss': float(self.calculated_metrics['averageProfitLossPercent'].mean()),
                'users_below_50_success': int(len(self.calculated_metrics[self.calculated_metrics['successRate'] < 50]))
            }
            
        # Save report
        with open('comprehensive_analysis_report.json', 'w') as f:
            json.dump(report, f, indent=2)
            
        print("✅ Saved comprehensive analysis report to: comprehensive_analysis_report.json")
        
    def run_comprehensive_analysis(self):
        """Run all analyses"""
        print("\n🚀 TRENCHES DATASET COMPREHENSIVE ANALYSIS")
        print("=" * 80)
        print(f"Generated at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        
        # Load data
        self.load_all_data()
        
        # Run all analyses
        self.dataset_overview()
        self.top_performers_analysis()
        self.worst_performers_analysis()
        self.realistic_worst_performers_analysis()
        self.performance_distribution_analysis()
        self.token_analysis()
        
        # Generate visualizations
        self.create_all_visualizations()
        
        # Generate summary report
        self.generate_summary_report()
        
        print("\n🎉 ANALYSIS COMPLETE!")
        print(f"Generated {len(self.figures)} visualizations and 1 summary report")
        print("\nOutput files:")
        for fig in self.figures:
            print(f"  - {fig}")
        print("  - comprehensive_analysis_report.json")

def main():
    parser = argparse.ArgumentParser(description='Comprehensive Trenches Dataset Analysis')
    parser.add_argument('--data-dir', type=str, default='../../data', 
                       help='Path to data directory')
    
    args = parser.parse_args()
    
    # Create analyzer and run
    analyzer = ComprehensiveAnalyzer(args.data_dir)
    analyzer.run_comprehensive_analysis()

if __name__ == "__main__":
    main() 