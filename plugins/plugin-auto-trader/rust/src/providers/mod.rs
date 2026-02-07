pub mod portfolio_status;

pub use portfolio_status::PortfolioStatusProvider;

pub fn get_trading_providers() -> Vec<Box<dyn crate::Provider>> {
    vec![Box::new(PortfolioStatusProvider)]
}
