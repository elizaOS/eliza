use std::time::Duration;
use computeruse::{platforms, AutomationError, Selector};
use tracing::{info, Level};

#[tokio::test]
#[ignore = "does not work atm"]
async fn test_path() -> Result<(), AutomationError> {
    tracing_subscriber::fmt::Subscriber::builder()
        .with_max_level(Level::DEBUG)
        .init();

    const DEFAULT_FIND_TIMEOUT: Duration = Duration::from_millis(10000);
    let timeout_ms = DEFAULT_FIND_TIMEOUT;

    // replace with updated selector from your own ui tree
    let sel = Selector::Path(
        "/Window[3]/Custom[8]/Pane/Document/Group[2]/Group[1]/Group[3]/Document[1]/Button[5]"
            .to_string(),
    );

    let engine = platforms::create_engine(false, false)?;
    let root = engine.get_root_element();

    let start = std::time::Instant::now();
    let ele = engine.find_element(&sel, Some(&root), Some(timeout_ms));
    let elapsed = start.elapsed();

    match ele {
        Ok(element) => {
            assert!(element.name().is_some(), "expected name for ui element");
            info!(
                "found element '{:?}' in time '{:?}'",
                element.name().unwrap(),
                elapsed
            );
        }
        Err(e) => {
            println!("error: {e:?}");
            return Err(e);
        }
    }
    Ok(())
}
