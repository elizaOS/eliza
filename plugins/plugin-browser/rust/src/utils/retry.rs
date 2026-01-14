use crate::types::RetryConfig;
use std::future::Future;
use std::time::Duration;
use tokio::time::sleep;
use tracing::{info, warn};

pub mod default_configs {
    use super::RetryConfig;

    pub fn navigation() -> RetryConfig {
        RetryConfig {
            max_attempts: 3,
            initial_delay_ms: 1000,
            max_delay_ms: 5000,
            backoff_multiplier: 2.0,
        }
    }

    pub fn action() -> RetryConfig {
        RetryConfig {
            max_attempts: 2,
            initial_delay_ms: 500,
            max_delay_ms: 2000,
            backoff_multiplier: 1.5,
        }
    }

    pub fn extraction() -> RetryConfig {
        RetryConfig {
            max_attempts: 2,
            initial_delay_ms: 500,
            max_delay_ms: 3000,
            backoff_multiplier: 2.0,
        }
    }
}

pub async fn retry_with_backoff<T, E, F, Fut>(
    mut f: F,
    config: &RetryConfig,
    operation: &str,
) -> Result<T, E>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, E>>,
    E: std::fmt::Debug,
{
    let mut delay = config.initial_delay_ms;
    let mut last_error: Option<E> = None;

    for attempt in 1..=config.max_attempts {
        info!(
            "Attempting {} (attempt {}/{})",
            operation, attempt, config.max_attempts
        );

        match f().await {
            Ok(result) => return Ok(result),
            Err(e) => {
                warn!(
                    "{} failed (attempt {}/{}): {:?}",
                    operation, attempt, config.max_attempts, e
                );
                last_error = Some(e);

                if attempt < config.max_attempts {
                    info!("Retrying {} in {}ms...", operation, delay);
                    sleep(Duration::from_millis(delay)).await;
                    delay = std::cmp::min(
                        (delay as f64 * config.backoff_multiplier) as u64,
                        config.max_delay_ms,
                    );
                }
            }
        }
    }

    tracing::error!(
        "{} failed after {} attempts",
        operation,
        config.max_attempts
    );
    Err(last_error.unwrap())
}

pub async fn sleep_ms(ms: u64) {
    sleep(Duration::from_millis(ms)).await;
}
