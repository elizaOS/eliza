pub mod analyze_performance;
pub mod check_portfolio;
pub mod compare_strategies;
pub mod configure_strategy;
pub mod execute_live_trade;
pub mod get_market_analysis;
pub mod run_backtest;
pub mod start_trading;
pub mod stop_trading;

pub use analyze_performance::AnalyzePerformanceAction;
pub use check_portfolio::CheckPortfolioAction;
pub use compare_strategies::CompareStrategiesAction;
pub use configure_strategy::ConfigureStrategyAction;
pub use execute_live_trade::ExecuteLiveTradeAction;
pub use get_market_analysis::GetMarketAnalysisAction;
pub use run_backtest::RunBacktestAction;
pub use start_trading::StartTradingAction;
pub use stop_trading::StopTradingAction;

pub fn get_trading_actions() -> Vec<Box<dyn crate::Action>> {
    vec![
        Box::new(StartTradingAction),
        Box::new(StopTradingAction),
        Box::new(CheckPortfolioAction),
        Box::new(RunBacktestAction),
        Box::new(CompareStrategiesAction),
        Box::new(AnalyzePerformanceAction),
        Box::new(GetMarketAnalysisAction),
        Box::new(ConfigureStrategyAction),
        Box::new(ExecuteLiveTradeAction),
    ]
}
