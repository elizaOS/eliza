use std::time::Duration;
use computeruse::Desktop;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();
    let desktop = Desktop::new_default()?;

    // Open notepad
    let app = desktop.open_application("notepad.exe")?;
    println!("Notepad opened successfully.");

    // Define a locator for the main text area in Notepad.
    // On Windows, this is often an "Edit" control, but on newer versions it might be "RichEditD2DPT"
    let editor_locator = desktop.locator("ClassName:Edit");
    let editor_locator_alt = desktop.locator("ClassName:RichEditD2DPT");

    // Test 1: Find the editor, expecting it to be visible.
    println!("Searching for visible editor...");
    let visible_editor = match editor_locator
        .visible(true)
        .first(Some(Duration::from_secs(2)))
        .await
    {
        Ok(element) => Ok(element),
        Err(_) => {
            editor_locator_alt
                .visible(true)
                .first(Some(Duration::from_secs(3)))
                .await
        }
    };

    match visible_editor {
        Ok(element) => {
            println!(
                "SUCCESS: Found visible editor: {:?}",
                element.name().unwrap_or_default()
            );
        }
        Err(e) => {
            println!("FAILURE: Did not find visible editor: {e}");
        }
    }

    // Test 2: Search for the editor with visible:false, expecting it to fail.
    println!("\nSearching for a non-visible editor (this should time out)...");
    let non_visible_editor = match editor_locator
        .visible(false)
        .first(Some(Duration::from_secs(2)))
        .await
    {
        Ok(element) => Ok(element),
        Err(_) => {
            editor_locator_alt
                .visible(false)
                .first(Some(Duration::from_secs(3)))
                .await
        }
    };

    match non_visible_editor {
        Ok(element) => {
            println!(
                "FAILURE: Found an element that should not be visible: {:?}",
                element.name().unwrap_or_default()
            );
        }
        Err(e) => {
            println!("SUCCESS: Correctly failed to find non-visible editor: {e}");
        }
    }

    // Close notepad
    app.close()?;
    println!("\nNotepad closed.");

    Ok(())
}
