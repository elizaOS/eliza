use computeruse::{AutomationError, Desktop};

#[tokio::main]
async fn main() -> Result<(), AutomationError> {
    tracing_subscriber::fmt::init();

    let desktop = Desktop::new(true, false)?;

    // let opened_app = desktop.focused_element()?;

    // let console_panel = desktop
    //     .locator("name:Console panel")
    //     .first(Some(Duration::from_millis(1000)))
    //     .await?;
    // // let console_panel_text = console_panel.text(100)?;
    // println!("Console panel text: {:?}", console_panel.name());

    // Get all groups in DevTools and manually get the -2 element
    let all_groups = desktop
        .locator("role:document >> role:Text >> nth=-6")
        .first(None)
        .await?;
    println!("All groups: {:?}", all_groups.name());

    // plan_info.type_text("document.getElementById('plan-info').innerText", true)?;
    // plan_info.press_key("{ENTER}")?;
    // tokio::time::sleep(Duration::from_millis(2000)).await;
    // // get the text of the last element in the console messages area
    // let console_messages = desktop
    //     .locator("role:document|name:DevTools >> role:text >> nth=-1")
    //     .first(None)
    //     .await?;
    // let text = console_messages.text(100)?;
    // println!("Text: {text}");

    // let tree = opened_app.to_serializable_tree(5);
    // let flat_tree = tree.children.iter().flatten().collect::<Vec<_>>();
    // // println!("{}", serde_json::to_string_pretty(&tree).unwrap());

    // // get the inde of first element which is a text element containing $ with a group before and after
    // let mut start: i32 = -1;

    // // get the index of the first element which is a text element containing a number followed
    // // by a text element containing "of " followed by a text element containing a number
    // let mut end: i32 = -1;

    // for (i, element) in flat_tree.iter().enumerate() {
    //     if element.role == "Text" {
    //         let text = element.text.clone().unwrap_or_default();
    //         if text.contains("$")
    //             && i > 0
    //             && i + 1 < flat_tree.len()
    //             && flat_tree[i - 1].role == "Group"
    //             && flat_tree[i + 1].role == "Group"
    //         {
    //             println!("Found text element containing $: {}", text);
    //             start = i as i32;
    //         }
    //         if text.contains("of ")
    //             && i > 0
    //             && i + 1 < flat_tree.len()
    //             && flat_tree[i - 1].role == "Group"
    //             && flat_tree[i + 1].role == "Group"
    //         {
    //             println!("Found text element containing of: {}", text);
    //             end = i as i32;
    //         }
    //     }
    // }

    // // print the concatenated text of the elements between start and end
    // if start != -1 && end != -1 {
    //     let text = flat_tree[start as usize..end as usize]
    //         .iter()
    //         .map(|e| e.text.clone().unwrap_or_default())
    //         .collect::<Vec<_>>()
    //         .join("");
    //     println!("Concatenated text: {}", text);
    // }

    Ok(())
}
