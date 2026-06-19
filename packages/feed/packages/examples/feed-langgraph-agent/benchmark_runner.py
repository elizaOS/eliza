"""
Benchmark Runner for Feed LangGraph Agent

Runs this agent through benchmark simulations to measure performance.
Uses the same LangGraph logic but with a simulated A2A interface.
"""

import json
import logging
import sys
import os
from datetime import datetime
from typing import Dict, Any, List
import asyncio

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

class BenchmarkSimulationA2A:
    """
    Simulation A2A client that replays pre-recorded benchmark data.
    Compatible with the agent's A2A interface expectations.
    """
    
    def __init__(self, snapshot: Dict[str, Any]):
        self.snapshot = snapshot
        self.current_tick = 0
        self.actions_taken = []
        
    def get_current_state(self):
        """Get game state for current tick"""
        if self.current_tick == 0:
            return self.snapshot['initialState']
        
        if self.current_tick - 1 < len(self.snapshot['ticks']):
            return self.snapshot['ticks'][self.current_tick - 1]['state']
        
        return self.snapshot['initialState']
    
    def advance_tick(self):
        """Move to next tick"""
        self.current_tick += 1
    
    async def get_predictions(self) -> Dict[str, Any]:
        """Get active prediction markets"""
        state = self.get_current_state()
        predictions = state.get('predictionMarkets', [])
        
        return {
            'predictions': [
                {
                    'id': m['id'],
                    'question': m['question'],
                    'yesPrice': m['yesPrice'],
                    'noPrice': m['noPrice'],
                    'yesShares': m['yesShares'],
                    'noShares': m['noShares'],
                    'liquidity': m.get('liquidity', 1000),
                    'totalVolume': m.get('totalVolume', 0),
                }
                for m in predictions
                if not m.get('resolved', False)
            ]
        }
    
    async def get_perpetuals(self) -> Dict[str, Any]:
        """Get perpetual markets"""
        state = self.get_current_state()
        perpetuals = state.get('perpetualMarkets', [])
        
        return {
            'perpetuals': [
                {
                    'ticker': m['ticker'],
                    'price': m['price'],
                    'priceChange24h': m.get('priceChange24h', 0),
                    'volume24h': m.get('volume24h', 0),
                    'openInterest': m.get('openInterest', 0),
                    'fundingRate': m.get('fundingRate', 0),
                }
                for m in perpetuals
            ]
        }
    
    async def get_feed(self, limit: int = 10) -> Dict[str, Any]:
        """Get social feed"""
        state = self.get_current_state()
        posts = state.get('posts', [])
        
        return {
            'posts': posts[-limit:] if len(posts) > limit else posts
        }
    
    async def get_portfolio(self) -> Dict[str, Any]:
        """Get agent portfolio (simplified)"""
        return {
            'balance': 10000,
            'positions': [],
            'pnl': 0
        }
    
    async def buy_shares(self, market_id: str, outcome: str, amount: float) -> Dict[str, Any]:
        """Buy prediction market shares"""
        action = {
            'type': 'buy_prediction',
            'tick': self.current_tick,
            'data': {
                'marketId': market_id,
                'outcome': outcome,
                'amount': amount
            }
        }
        self.actions_taken.append(action)
        
        return {
            'success': True,
            'shares': amount * 0.5,  # Simplified
            'positionId': f'pos-{len(self.actions_taken)}'
        }
    
    async def open_position(self, ticker: str, side: str, size: float, leverage: int) -> Dict[str, Any]:
        """Open perpetual position"""
        action = {
            'type': 'open_perp',
            'tick': self.current_tick,
            'data': {
                'ticker': ticker,
                'side': side,
                'size': size,
                'leverage': leverage
            }
        }
        self.actions_taken.append(action)
        
        return {
            'success': True,
            'positionId': f'perp-{len(self.actions_taken)}'
        }
    
    async def create_post(self, content: str, market_id: str = None) -> Dict[str, Any]:
        """Create social post"""
        action = {
            'type': 'create_post',
            'tick': self.current_tick,
            'data': {
                'content': content,
                'marketId': market_id
            }
        }
        self.actions_taken.append(action)
        
        return {
            'success': True,
            'postId': f'post-{len(self.actions_taken)}'
        }


async def run_benchmark(
    benchmark_file: str,
    output_dir: str,
    agent_module: str = 'agent'
) -> Dict[str, Any]:
    """
    Run agent through benchmark simulation
    
    Args:
        benchmark_file: Path to benchmark JSON file
        output_dir: Directory to save results
        agent_module: Python module name with agent (default: 'agent')
    
    Returns:
        Simulation results dictionary
    """
    
    logger.info('🎯 Starting LangGraph Agent Benchmark')
    logger.info(f'Benchmark: {benchmark_file}')
    logger.info(f'Output: {output_dir}')
    
    # 1. Load benchmark
    logger.info('📊 Loading benchmark data...')
    with open(benchmark_file, 'r') as f:
        snapshot = json.load(f)
    
    total_ticks = len(snapshot['ticks'])
    logger.info(f'  Loaded: {total_ticks} ticks')
    
    # 2. Create simulation A2A client
    logger.info('🔌 Creating simulation A2A client...')
    a2a_client = BenchmarkSimulationA2A(snapshot)
    
    # 3. Import agent
    logger.info(f'🤖 Loading agent from {agent_module}...')
    try:
        agent = __import__(agent_module)
        logger.info('  Agent loaded successfully')
    except ImportError as e:
        logger.error(f'Failed to import agent: {e}')
        raise
    
    # 4. Run simulation loop
    logger.info('🚀 Starting simulation loop...')
    tick_count = 0
    
    while a2a_client.current_tick < total_ticks:
        tick_count += 1
        
        if tick_count % 10 == 0 or tick_count == 1:
            progress = (tick_count / total_ticks) * 100
            logger.info(f'  Tick {tick_count}/{total_ticks} ({progress:.0f}%)')
        
        try:
            # Gather context
            predictions = await a2a_client.get_predictions()
            perpetuals = await a2a_client.get_perpetuals()
            feed = await a2a_client.get_feed(10)
            portfolio = await a2a_client.get_portfolio()
            
            # Build context for agent
            context = {
                'predictions': predictions.get('predictions', []),
                'perpetuals': perpetuals.get('perpetuals', []),
                'feed': feed.get('posts', []),
                'portfolio': portfolio
            }
            
            # Make decision using agent's logic
            # (This would call your agent's decision function)
            # For now, simplified example:
            await make_agent_decision(agent, context, a2a_client)
            
            # Advance tick
            a2a_client.advance_tick()
            
        except Exception as e:
            logger.warning(f'  ⚠️  Error on tick {tick_count}: {e}')
            # Continue anyway
            a2a_client.advance_tick()
    
    logger.info(f'✅ Simulation complete: {tick_count} ticks processed')
    
    # 5. Calculate metrics
    logger.info('📊 Calculating metrics...')
    metrics = calculate_metrics(a2a_client.actions_taken, snapshot)
    
    # 6. Save results
    logger.info('💾 Saving results...')
    os.makedirs(output_dir, exist_ok=True)
    
    result = {
        'id': f'langgraph-{datetime.now().isoformat()}',
        'agentType': 'langgraph',
        'benchmarkId': snapshot['id'],
        'ticksProcessed': tick_count,
        'actions': a2a_client.actions_taken,
        'metrics': metrics,
        'startTime': snapshot.get('createdAt', 0),
        'endTime': datetime.now().timestamp() * 1000
    }
    
    with open(os.path.join(output_dir, 'result.json'), 'w') as f:
        json.dump(result, f, indent=2)
    
    with open(os.path.join(output_dir, 'metrics.json'), 'w') as f:
        json.dump(metrics, f, indent=2)
    
    # Log summary
    logger.info('✅ Benchmark Complete!')
    logger.info('')
    logger.info('Results:')
    logger.info(f"  Total P&L: ${metrics.get('totalPnl', 0):.2f}")
    logger.info(f"  Prediction Accuracy: {metrics.get('predictionAccuracy', 0)*100:.1f}%")
    logger.info(f"  Perp Win Rate: {metrics.get('perpWinRate', 0)*100:.1f}%")
    logger.info(f"  Actions Taken: {len(a2a_client.actions_taken)}")
    logger.info('')
    logger.info(f"View results: {output_dir}")
    
    return result


async def make_agent_decision(agent, context: Dict[str, Any], a2a_client: BenchmarkSimulationA2A):
    """
    Make decision using agent's logic
    
    This is a simplified example - you would integrate your actual
    LangGraph agent decision-making here.
    """
    
    # Simple heuristic for demo:
    # - Look at predictions
    # - If any are mispriced, take action
    
    predictions = context.get('predictions', [])
    
    for market in predictions:
        yes_price = market.get('yesPrice', 0.5)
        
        # Simple strategy: buy YES if price < 0.4, buy NO if price > 0.6
        if yes_price < 0.4:
            await a2a_client.buy_shares(
                market_id=market['id'],
                outcome='YES',
                amount=100
            )
            break
        elif yes_price > 0.6:
            await a2a_client.buy_shares(
                market_id=market['id'],
                outcome='NO',
                amount=100
            )
            break


def calculate_metrics(actions: List[Dict[str, Any]], snapshot: Dict[str, Any]) -> Dict[str, Any]:
    """Calculate performance metrics from actions"""
    
    # Count action types
    prediction_actions = [a for a in actions if a['type'] == 'buy_prediction']
    perp_actions = [a for a in actions if a['type'] == 'open_perp']
    post_actions = [a for a in actions if a['type'] == 'create_post']
    
    # Simplified metrics calculation
    # In a real implementation, you would:
    # 1. Track position outcomes against ground truth
    # 2. Calculate actual P&L
    # 3. Measure timing of actions
    
    return {
        'totalPnl': 0,  # Would calculate from positions
        'predictionAccuracy': 0,  # Would compare against ground truth
        'perpWinRate': 0,  # Would track perp outcomes
        'actionsBreakdown': {
            'predictions': len(prediction_actions),
            'perpetuals': len(perp_actions),
            'posts': len(post_actions),
            'total': len(actions)
        },
        'timing': {
            'avgResponseTime': 0,
            'totalDuration': 0
        }
    }


async def run_multiple(
    benchmark_file: str,
    output_dir: str,
    runs: int,
    agent_module: str = 'agent'
):
    """Run multiple benchmark iterations"""
    
    logger.info(f'🔄 Running {runs} benchmark iterations')
    
    results = []
    
    for i in range(runs):
        logger.info('')
        logger.info('━' * 50)
        logger.info(f'Run {i+1}/{runs}')
        logger.info('━' * 50)
        
        run_dir = os.path.join(output_dir, f'run-{i+1}')
        result = await run_benchmark(benchmark_file, run_dir, agent_module)
        results.append(result)
        
        # Delay between runs
        await asyncio.sleep(1)
    
    # Calculate comparison
    avg_pnl = sum(r['metrics'].get('totalPnl', 0) for r in results) / runs
    avg_accuracy = sum(r['metrics'].get('predictionAccuracy', 0) for r in results) / runs
    
    comparison = {
        'runs': results,
        'comparison': {
            'avgPnl': avg_pnl,
            'avgAccuracy': avg_accuracy,
            'totalRuns': runs
        }
    }
    
    with open(os.path.join(output_dir, 'comparison.json'), 'w') as f:
        json.dump(comparison, f, indent=2)
    
    logger.info('')
    logger.info('━' * 50)
    logger.info('🏆 ALL BENCHMARKS COMPLETE')
    logger.info('━' * 50)
    logger.info(f'  Runs: {runs}')
    logger.info(f'  Avg P&L: ${avg_pnl:.2f}')
    logger.info(f'  Avg Accuracy: {avg_accuracy*100:.1f}%')
    logger.info('')
    logger.info(f'Results: {output_dir}')


def main():
    """CLI entry point"""
    
    import argparse
    
    parser = argparse.ArgumentParser(description='Run LangGraph agent through benchmark')
    parser.add_argument('--benchmark', required=True, help='Path to benchmark JSON file')
    parser.add_argument('--output', default=f'./benchmark-results/{int(datetime.now().timestamp())}',
                       help='Output directory for results')
    parser.add_argument('--runs', type=int, default=1, help='Number of runs (default: 1)')
    parser.add_argument('--agent', default='agent', help='Agent module name (default: agent)')
    
    args = parser.parse_args()
    
    try:
        if args.runs == 1:
            asyncio.run(run_benchmark(args.benchmark, args.output, args.agent))
        else:
            asyncio.run(run_multiple(args.benchmark, args.output, args.runs, args.agent))
    except Exception as e:
        logger.error(f'❌ Benchmark failed: {e}')
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    main()


