use computeruse::{platforms, AutomationError, Selector};
use tracing::Level;

#[tokio::main]
async fn main() -> Result<(), AutomationError> {
    tracing_subscriber::fmt::Subscriber::builder()
        .with_max_level(Level::DEBUG)
        .init();
    // example for `name along with role`
    let engine = platforms::create_engine(true, true)?;

    let opened_app = engine.open_application("uwp:Microsoft.MicrosoftEdge.Stable")?;

    // target more specific!!
    let tool_bar = Selector::Role {
        role: "ToolBar".to_string(),
        name: Some("App bar".to_string()),
    };

    let tool_bar = engine.find_element(&tool_bar, Some(&opened_app), None)?;

    // this will get any random button, regardless of its name
    let rand_button = Selector::Role {
        role: "Button".to_string(),
        name: None,
    };

    let rand_button_ele = engine.find_element(&rand_button, Some(&tool_bar), None)?;
    rand_button_ele.click()?;

    std::thread::sleep(std::time::Duration::from_millis(3000));

    // this will get the button with the specific name of `Settings and more`
    let three_dots = Selector::Role {
        role: "Button".to_string(),
        name: Some("Settings and more".to_string()),
    };
    let rand_button_ele = engine.find_element(&three_dots, Some(&tool_bar), None)?;
    rand_button_ele.click()?;

    std::thread::sleep(std::time::Duration::from_millis(3000));

    let split_screen = Selector::Role {
        role: "Menuitem".to_string(),
        name: Some("Split screen".to_string()),
    };

    let split_screen_ele = engine.find_element(&split_screen, Some(&opened_app), None)?;
    split_screen_ele.click()?;

    Ok(())
}
