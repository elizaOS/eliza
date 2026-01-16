use crate::{AutomationError, Desktop, Selector};
use std::time::Duration;

#[tokio::test]
#[ignore]
async fn test_toggle_checkbox() -> Result<(), AutomationError> {
    let desktop = Desktop::new(false, false)?;
    let app = desktop.open_url("https://ui.shadcn.com/docs/components/checkbox", None)?;

    let checkbox = app
        .locator(Selector::Role {
            role: "checkbox".to_string(),
            name: Some("Accept terms and conditions".to_string()),
        })?
        .first(Some(Duration::from_secs(10)))
        .await?;

    println!("checkbox: {:?}", checkbox.name());

    let initial_state = checkbox.is_toggled()?;
    assert!(!initial_state, "Checkbox should be initially unselected");

    // Toggle it on
    checkbox.set_toggled(true)?;
    // Give it a moment to react
    tokio::time::sleep(Duration::from_millis(500)).await;
    let new_state = checkbox.is_toggled()?;
    assert!(new_state, "Checkbox should be selected after toggling on");

    // Toggle it back off
    checkbox.set_toggled(false)?;
    tokio::time::sleep(Duration::from_millis(500)).await;

    let final_state = checkbox.is_toggled()?;
    assert!(
        !final_state,
        "Checkbox should be unselected after toggling off"
    );

    app.close()?;
    Ok(())
}

#[tokio::test]
#[ignore]
async fn test_slider_value() -> Result<(), AutomationError> {
    let desktop = Desktop::new(false, false)?;
    // Using a native windows app with a slider for reliability
    let app = desktop.open_application("ms-settings:sound")?;

    let slider = app
        .locator(Selector::Role {
            role: "slider".to_string(),
            name: Some("Adjust the output volume".to_string()),
        })?
        .first(Some(Duration::from_secs(2)))
        .await?;

    let initial_value = slider.get_range_value()?;
    println!("Initial slider value: {initial_value}");

    // Set slider to a different value
    let new_value: f64 = if initial_value < 50.0 { 75.0 } else { 25.0 };
    println!("Setting slider value to: {new_value}");
    slider.set_range_value(new_value)?;

    // Give it a moment to react and update
    tokio::time::sleep(Duration::from_millis(1000)).await;
    let updated_value = slider.get_range_value()?;
    println!("Updated slider value: {updated_value}");

    // Using a tolerance for floating point comparison
    assert!(
        (new_value - updated_value).abs() < 1.0,
        "Slider value should be updated to approx {new_value}. It is {updated_value}"
    );

    // Set it back
    println!("Setting slider value back to: {initial_value}");
    slider.set_range_value(initial_value)?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let final_value = slider.get_range_value()?;
    println!("Final slider value: {final_value}");
    assert!(
        (initial_value - final_value).abs() < 1.0,
        "Slider value should be back to initial. It is {final_value}"
    );

    app.close()?;
    Ok(())
}

#[tokio::test]
#[ignore] // todo does not work - idk whats the best practice for calendar automation thing
async fn test_calendar_selection() -> Result<(), AutomationError> {
    let desktop = Desktop::new(false, false)?;
    let app = desktop.open_url("https://ui.shadcn.com/docs/components/calendar", None)?;

    // sleep for 10 seconds
    tokio::time::sleep(Duration::from_secs(2)).await;

    let selected_date = app
        .locator("role:dataitem")?
        .first(Some(Duration::from_secs(5)))
        .await?;

    // let is_selected = selected_date.is_selected()?;
    // println!("is_selected: {:?}", is_selected);
    println!("selected_date: {:?}", selected_date.name());

    selected_date.set_selected(true)?;

    println!("selected_date: {:?}", selected_date.name());
    tokio::time::sleep(Duration::from_millis(2000)).await;

    let is_selected = selected_date.is_selected()?;
    println!("is_selected: {is_selected:?}");

    assert!(is_selected, "The 6th should now be selected");

    app.close()?;
    Ok(())
}
