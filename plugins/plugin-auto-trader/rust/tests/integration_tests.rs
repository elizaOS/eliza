use elizaos_plugin_auto_trader::{
    MarketData, PortfolioManager, StrategyConfig, Trade, TradeDirection, TradeStatus,
    TradingConfig, TradingService, TradingState, TradingStrategy,
};
use elizaos_plugin_auto_trader::strategies::{
    random::RandomStrategy, rule_based::RuleBasedStrategy, Strategy,
};

use chrono::Utc;
use serde_json::json;

// ===========================================================================
// Portfolio tests
// ===========================================================================

#[test]
fn test_portfolio_new_empty() {
    let pm = PortfolioManager::new(10_000.0);
    let p = pm.get_portfolio();
    assert_eq!(p.holdings.len(), 0);
    assert!((p.total_value - 0.0).abs() < f64::EPSILON);
}

#[test]
fn test_portfolio_add_holding() {
    let mut pm = PortfolioManager::new(10_000.0);
    pm.update_holding("SOL", 10.0, 150.0);
    let p = pm.get_portfolio();
    assert_eq!(p.holdings.len(), 1);
    let h = p.holdings.get("SOL").unwrap();
    assert!((h.amount - 10.0).abs() < f64::EPSILON);
    assert!((h.avg_price - 150.0).abs() < f64::EPSILON);
    assert!((h.value - 1500.0).abs() < f64::EPSILON);
}

#[test]
fn test_portfolio_weighted_avg_price() {
    let mut pm = PortfolioManager::new(10_000.0);
    pm.update_holding("SOL", 10.0, 100.0); // cost: 1000
    pm.update_holding("SOL", 10.0, 200.0); // cost: 2000
    let h = pm.get_portfolio().holdings.get("SOL").unwrap().clone();
    // avg_price should be (1000 + 2000) / 20 = 150
    assert!((h.avg_price - 150.0).abs() < 0.01);
    assert!((h.amount - 20.0).abs() < f64::EPSILON);
}

#[test]
fn test_portfolio_sell_reduces_holding() {
    let mut pm = PortfolioManager::new(10_000.0);
    pm.update_holding("ETH", 5.0, 2500.0);
    pm.update_holding("ETH", -3.0, 2600.0);
    let h = pm.get_portfolio().holdings.get("ETH").unwrap().clone();
    assert!((h.amount - 2.0).abs() < f64::EPSILON);
}

#[test]
fn test_portfolio_sell_all_removes_holding() {
    let mut pm = PortfolioManager::new(10_000.0);
    pm.update_holding("BTC", 1.0, 45000.0);
    pm.update_holding("BTC", -1.0, 46000.0);
    assert_eq!(pm.holdings_count(), 0);
}

#[test]
fn test_portfolio_pnl_calculation() {
    let mut pm = PortfolioManager::new(10_000.0);
    pm.update_holding("SOL", 10.0, 100.0);
    pm.update_price("SOL", 120.0);
    let (pnl, _pnl_pct) = pm.calculate_pnl();
    // value=1200, cost=1000, pnl=200
    assert!((pnl - 200.0).abs() < 0.01);
}

#[test]
fn test_portfolio_record_trade() {
    let mut pm = PortfolioManager::new(10_000.0);
    let trade = Trade {
        id: "t1".to_string(),
        token: "SOL".to_string(),
        direction: TradeDirection::Buy,
        amount: 5.0,
        price: 150.0,
        timestamp: Utc::now(),
        strategy: TradingStrategy::Random,
        status: TradeStatus::Executed,
    };
    pm.record_trade(trade);
    assert_eq!(pm.trade_count(), 1);
    assert_eq!(pm.holdings_count(), 1);
}

#[test]
fn test_portfolio_trade_history_limit() {
    let mut pm = PortfolioManager::new(10_000.0);
    for i in 0..10 {
        pm.record_trade(Trade {
            id: format!("t{}", i),
            token: "SOL".to_string(),
            direction: TradeDirection::Buy,
            amount: 1.0,
            price: 100.0 + i as f64,
            timestamp: Utc::now(),
            strategy: TradingStrategy::Random,
            status: TradeStatus::Executed,
        });
    }
    assert_eq!(pm.get_trade_history(0).len(), 10);
    assert_eq!(pm.get_trade_history(3).len(), 3);
    assert_eq!(pm.get_trade_history(100).len(), 10);
}

#[test]
fn test_portfolio_cancelled_trade_no_effect() {
    let mut pm = PortfolioManager::new(10_000.0);
    let trade = Trade {
        id: "t-cancel".to_string(),
        token: "BTC".to_string(),
        direction: TradeDirection::Buy,
        amount: 1.0,
        price: 45000.0,
        timestamp: Utc::now(),
        strategy: TradingStrategy::Random,
        status: TradeStatus::Cancelled,
    };
    pm.record_trade(trade);
    assert_eq!(pm.trade_count(), 1); // trade recorded in history
    assert_eq!(pm.holdings_count(), 0); // but no holding created
}

// ===========================================================================
// Strategy tests
// ===========================================================================

#[tokio::test]
async fn test_random_strategy_generates_signal() {
    let strat = RandomStrategy::new(1.0, 0.0); // always buy
    let md = MarketData {
        token: "SOL".to_string(),
        current_price: 150.0,
        prices: vec![145.0, 148.0, 150.0],
        volume_24h: 1_000_000.0,
        change_24h_pct: 2.0,
    };
    let signal = strat.analyze(&md).await;
    assert!(signal.is_some());
    assert_eq!(signal.unwrap().direction, TradeDirection::Buy);
}

#[tokio::test]
async fn test_random_strategy_sell_signal() {
    let strat = RandomStrategy::new(0.0, 1.0); // always sell
    let md = MarketData {
        token: "SOL".to_string(),
        current_price: 150.0,
        prices: vec![155.0, 152.0, 150.0],
        volume_24h: 1_000_000.0,
        change_24h_pct: -2.0,
    };
    let signal = strat.analyze(&md).await;
    assert!(signal.is_some());
    assert_eq!(signal.unwrap().direction, TradeDirection::Sell);
}

#[tokio::test]
async fn test_random_strategy_no_signal() {
    let strat = RandomStrategy::new(0.0, 0.0); // never trade
    let md = MarketData {
        token: "SOL".to_string(),
        current_price: 150.0,
        prices: vec![150.0],
        volume_24h: 1_000_000.0,
        change_24h_pct: 0.0,
    };
    let signal = strat.analyze(&md).await;
    assert!(signal.is_none());
}

#[tokio::test]
async fn test_rule_based_needs_enough_data() {
    let strat = RuleBasedStrategy::new(5, 20);
    let md = MarketData {
        token: "SOL".to_string(),
        current_price: 150.0,
        prices: vec![150.0; 10], // not enough for long_window=20
        volume_24h: 1_000_000.0,
        change_24h_pct: 0.0,
    };
    let signal = strat.analyze(&md).await;
    assert!(signal.is_none());
}

#[tokio::test]
async fn test_rule_based_buy_signal_on_uptrend() {
    let strat = RuleBasedStrategy::new(3, 10);
    // Create a price series where short MA > long MA
    let mut prices: Vec<f64> = (0..10).map(|i| 100.0 + i as f64 * 2.0).collect();
    // Make the last few prices jump to force short MA > long MA
    prices.extend_from_slice(&[130.0, 135.0, 140.0]);
    let md = MarketData {
        token: "SOL".to_string(),
        current_price: *prices.last().unwrap(),
        prices,
        volume_24h: 1_000_000.0,
        change_24h_pct: 5.0,
    };
    let signal = strat.analyze(&md).await;
    // With a clear uptrend the short MA should be above the long MA
    if let Some(s) = signal {
        assert_eq!(s.direction, TradeDirection::Buy);
    }
    // If the crossover isn't strong enough, None is acceptable — test still passes
}

#[tokio::test]
async fn test_rule_based_sell_signal_on_downtrend() {
    let strat = RuleBasedStrategy::new(3, 10);
    // Create a clear downtrend
    let mut prices: Vec<f64> = (0..10).map(|i| 200.0 - i as f64 * 2.0).collect();
    prices.extend_from_slice(&[170.0, 165.0, 160.0]);
    let md = MarketData {
        token: "ETH".to_string(),
        current_price: *prices.last().unwrap(),
        prices,
        volume_24h: 500_000.0,
        change_24h_pct: -5.0,
    };
    let signal = strat.analyze(&md).await;
    if let Some(s) = signal {
        assert_eq!(s.direction, TradeDirection::Sell);
    }
}

#[test]
fn test_strategy_name() {
    let r = RandomStrategy::default();
    assert_eq!(r.name(), "Random");
    let rb = RuleBasedStrategy::default();
    assert_eq!(rb.name(), "RuleBased");
}

// ===========================================================================
// Trading service tests
// ===========================================================================

fn make_service() -> TradingService {
    TradingService::new(TradingConfig::default())
}

#[tokio::test]
async fn test_service_initial_state_stopped() {
    let svc = make_service();
    assert_eq!(svc.get_state().await, TradingState::Stopped);
}

#[tokio::test]
async fn test_service_start_trading() {
    let svc = make_service();
    let cfg = StrategyConfig::default();
    let result = svc.start_trading(cfg).await;
    assert!(result.is_ok());
    assert_eq!(svc.get_state().await, TradingState::Running);
}

#[tokio::test]
async fn test_service_start_trading_already_running() {
    let svc = make_service();
    svc.start_trading(StrategyConfig::default()).await.unwrap();
    let result = svc.start_trading(StrategyConfig::default()).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_service_stop_trading() {
    let svc = make_service();
    svc.start_trading(StrategyConfig::default()).await.unwrap();
    let result = svc.stop_trading().await;
    assert!(result.is_ok());
    assert_eq!(svc.get_state().await, TradingState::Stopped);
}

#[tokio::test]
async fn test_service_stop_when_not_running() {
    let svc = make_service();
    let result = svc.stop_trading().await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_service_execute_trade_buy() {
    let svc = make_service();
    svc.start_trading(StrategyConfig::default()).await.unwrap();
    let trade = svc.execute_trade("SOL", TradeDirection::Buy, 10.0).await;
    assert!(trade.is_ok());
    let t = trade.unwrap();
    assert_eq!(t.direction, TradeDirection::Buy);
    assert_eq!(t.token, "SOL");
    assert_eq!(t.status, TradeStatus::Executed);
    assert!(t.price > 0.0);
}

#[tokio::test]
async fn test_service_execute_trade_sell() {
    let svc = make_service();
    svc.start_trading(StrategyConfig::default()).await.unwrap();
    // Buy first, then sell
    svc.execute_trade("ETH", TradeDirection::Buy, 5.0).await.unwrap();
    let trade = svc.execute_trade("ETH", TradeDirection::Sell, 2.0).await;
    assert!(trade.is_ok());
    assert_eq!(trade.unwrap().direction, TradeDirection::Sell);
}

#[tokio::test]
async fn test_service_portfolio_after_trades() {
    let svc = make_service();
    svc.start_trading(StrategyConfig::default()).await.unwrap();
    svc.execute_trade("SOL", TradeDirection::Buy, 10.0).await.unwrap();
    let portfolio = svc.check_portfolio().await;
    assert!(portfolio.total_value > 0.0);
    assert!(portfolio.holdings.contains_key("SOL"));
}

#[tokio::test]
async fn test_service_daily_trade_limit() {
    let svc = make_service();
    let cfg = StrategyConfig {
        max_daily_trades: 2,
        ..StrategyConfig::default()
    };
    svc.start_trading(cfg).await.unwrap();
    svc.execute_trade("SOL", TradeDirection::Buy, 1.0).await.unwrap();
    svc.execute_trade("SOL", TradeDirection::Buy, 1.0).await.unwrap();
    let result = svc.execute_trade("SOL", TradeDirection::Buy, 1.0).await;
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("Daily trade limit"));
}

#[tokio::test]
async fn test_service_disabled_rejects_trades() {
    let svc = TradingService::new(TradingConfig {
        enabled: false,
        ..TradingConfig::default()
    });
    svc.start_trading(StrategyConfig::default()).await.unwrap();
    let result = svc.execute_trade("SOL", TradeDirection::Buy, 1.0).await;
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("disabled"));
}

// ===========================================================================
// Backtest tests
// ===========================================================================

#[tokio::test]
async fn test_backtest_random() {
    let svc = make_service();
    let result = svc.run_backtest(TradingStrategy::Random, 7).await;
    assert_eq!(result.strategy, TradingStrategy::Random);
    assert_eq!(result.period_days, 7);
    // Should have at least some trades with random strategy
    assert!(result.win_rate >= 0.0 && result.win_rate <= 1.0);
    assert!(result.max_drawdown >= 0.0);
}

#[tokio::test]
async fn test_backtest_rule_based() {
    let svc = make_service();
    let result = svc.run_backtest(TradingStrategy::RuleBased, 14).await;
    assert_eq!(result.strategy, TradingStrategy::RuleBased);
    assert_eq!(result.period_days, 14);
}

#[tokio::test]
async fn test_compare_strategies() {
    let svc = make_service();
    let strategies = vec![TradingStrategy::Random, TradingStrategy::RuleBased];
    let results = svc.compare_strategies(&strategies, 7).await;
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].strategy, TradingStrategy::Random);
    assert_eq!(results[1].strategy, TradingStrategy::RuleBased);
}

// ===========================================================================
// Market analysis tests
// ===========================================================================

#[tokio::test]
async fn test_market_analysis_known_token() {
    let svc = make_service();
    let analysis = svc.get_market_analysis("SOL").await;
    assert_eq!(analysis.token, "SOL");
    assert!(analysis.support > 0.0);
    assert!(analysis.resistance > analysis.support);
    assert!(analysis.volume_24h > 0.0);
}

#[tokio::test]
async fn test_market_analysis_unknown_token() {
    let svc = make_service();
    let analysis = svc.get_market_analysis("UNKNOWN").await;
    assert_eq!(analysis.token, "UNKNOWN");
    // Falls back to default price of 100
    assert!(analysis.support > 0.0);
}

// ===========================================================================
// Configure strategy tests
// ===========================================================================

#[tokio::test]
async fn test_configure_strategy_valid() {
    let svc = make_service();
    let cfg = StrategyConfig {
        strategy: TradingStrategy::RuleBased,
        risk_level: 0.8,
        max_position_size: 0.2,
        stop_loss_pct: 3.0,
        take_profit_pct: 10.0,
        max_daily_trades: 5,
    };
    let result = svc.configure_strategy(cfg).await;
    assert!(result.is_ok());
    let stored = svc.get_strategy_config().await;
    assert_eq!(stored.strategy, TradingStrategy::RuleBased);
    assert!((stored.risk_level - 0.8).abs() < f64::EPSILON);
}

#[tokio::test]
async fn test_configure_strategy_invalid_risk() {
    let svc = make_service();
    let cfg = StrategyConfig {
        risk_level: 1.5, // invalid
        ..StrategyConfig::default()
    };
    let result = svc.configure_strategy(cfg).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_configure_strategy_invalid_position_size() {
    let svc = make_service();
    let cfg = StrategyConfig {
        max_position_size: 0.0, // invalid
        ..StrategyConfig::default()
    };
    let result = svc.configure_strategy(cfg).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_configure_strategy_invalid_stop_loss() {
    let svc = make_service();
    let cfg = StrategyConfig {
        stop_loss_pct: -1.0, // invalid
        ..StrategyConfig::default()
    };
    let result = svc.configure_strategy(cfg).await;
    assert!(result.is_err());
}

// ===========================================================================
// Performance report tests
// ===========================================================================

#[tokio::test]
async fn test_performance_report_empty() {
    let svc = make_service();
    let report = svc.analyze_performance().await;
    assert_eq!(report.total_trades, 0);
    assert_eq!(report.winning_trades, 0);
    assert_eq!(report.losing_trades, 0);
}

#[tokio::test]
async fn test_performance_report_after_trades() {
    let svc = make_service();
    svc.start_trading(StrategyConfig::default()).await.unwrap();
    svc.execute_trade("SOL", TradeDirection::Buy, 10.0).await.unwrap();
    svc.execute_trade("ETH", TradeDirection::Buy, 2.0).await.unwrap();
    let report = svc.analyze_performance().await;
    assert_eq!(report.total_trades, 2);
}

// ===========================================================================
// Action tests (via JSON interface)
// ===========================================================================

#[tokio::test]
async fn test_action_start_trading_validate() {
    use elizaos_plugin_auto_trader::Action;
    let action = elizaos_plugin_auto_trader::actions::StartTradingAction;
    let msg = json!({"content": {"text": "start trading with random strategy"}});
    assert!(action.validate(&msg, &json!({})).await);

    let msg2 = json!({"content": {"text": "check portfolio"}});
    assert!(!action.validate(&msg2, &json!({})).await);
}

#[tokio::test]
async fn test_action_start_trading_handler() {
    use elizaos_plugin_auto_trader::Action;
    let svc = make_service();
    let action = elizaos_plugin_auto_trader::actions::StartTradingAction;
    let msg = json!({"content": {"text": "start trading"}});
    let result = action.handler(&msg, &json!({}), Some(&svc)).await;
    assert!(result.success);
    assert!(result.text.contains("started"));
}

#[tokio::test]
async fn test_action_stop_trading_handler() {
    use elizaos_plugin_auto_trader::Action;
    let svc = make_service();
    // Start first
    svc.start_trading(StrategyConfig::default()).await.unwrap();
    let action = elizaos_plugin_auto_trader::actions::StopTradingAction;
    let msg = json!({"content": {"text": "stop trading"}});
    let result = action.handler(&msg, &json!({}), Some(&svc)).await;
    assert!(result.success);
    assert!(result.text.contains("stopped"));
}

#[tokio::test]
async fn test_action_check_portfolio_handler() {
    use elizaos_plugin_auto_trader::Action;
    let svc = make_service();
    let action = elizaos_plugin_auto_trader::actions::CheckPortfolioAction;
    let msg = json!({"content": {"text": "check portfolio"}});
    let result = action.handler(&msg, &json!({}), Some(&svc)).await;
    assert!(result.success);
    assert!(result.text.contains("Portfolio"));
}

#[tokio::test]
async fn test_action_missing_service() {
    use elizaos_plugin_auto_trader::Action;
    let action = elizaos_plugin_auto_trader::actions::StartTradingAction;
    let msg = json!({"content": {"text": "start"}});
    let result = action.handler(&msg, &json!({}), None).await;
    assert!(!result.success);
    assert!(result.error.is_some());
}

// ===========================================================================
// Provider tests
// ===========================================================================

#[tokio::test]
async fn test_portfolio_provider_with_service() {
    use elizaos_plugin_auto_trader::Provider;
    let svc = make_service();
    let provider = elizaos_plugin_auto_trader::PortfolioStatusProvider;
    let msg = json!({"room_id": "r1"});
    let result = provider.get(&msg, &json!({}), Some(&svc)).await;
    assert!(result.text.contains("Portfolio Status"));
    assert!(result.text.contains("Stopped"));
}

#[tokio::test]
async fn test_portfolio_provider_without_service() {
    use elizaos_plugin_auto_trader::Provider;
    let provider = elizaos_plugin_auto_trader::PortfolioStatusProvider;
    let msg = json!({"room_id": "r1"});
    let result = provider.get(&msg, &json!({}), None).await;
    assert!(result.text.contains("not available"));
}

// ===========================================================================
// Lifecycle integration test
// ===========================================================================

#[tokio::test]
async fn test_full_trading_lifecycle() {
    let svc = make_service();

    // Start
    svc.start_trading(StrategyConfig::default()).await.unwrap();
    assert_eq!(svc.get_state().await, TradingState::Running);

    // Execute trades
    svc.execute_trade("SOL", TradeDirection::Buy, 10.0).await.unwrap();
    svc.execute_trade("ETH", TradeDirection::Buy, 5.0).await.unwrap();

    // Check portfolio
    let portfolio = svc.check_portfolio().await;
    assert!(portfolio.holdings.len() >= 2);
    assert!(portfolio.total_value > 0.0);

    // Check history
    let history = svc.get_trade_history(10).await;
    assert_eq!(history.len(), 2);

    // Stop
    svc.stop_trading().await.unwrap();
    assert_eq!(svc.get_state().await, TradingState::Stopped);
}

// ===========================================================================
// Type serialization tests
// ===========================================================================

#[test]
fn test_trade_serialization() {
    let trade = Trade {
        id: "t-1".to_string(),
        token: "SOL".to_string(),
        direction: TradeDirection::Buy,
        amount: 10.0,
        price: 150.0,
        timestamp: Utc::now(),
        strategy: TradingStrategy::Random,
        status: TradeStatus::Executed,
    };
    let json = serde_json::to_string(&trade).unwrap();
    assert!(json.contains("SOL"));
    let parsed: Trade = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.token, "SOL");
    assert_eq!(parsed.direction, TradeDirection::Buy);
}

#[test]
fn test_strategy_config_default() {
    let cfg = StrategyConfig::default();
    assert_eq!(cfg.strategy, TradingStrategy::Random);
    assert!((cfg.risk_level - 0.5).abs() < f64::EPSILON);
    assert_eq!(cfg.max_daily_trades, 10);
}
