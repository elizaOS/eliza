use anyhow::Result;
use elizaos::{
    parse_character,
    runtime::{AgentRuntime, RuntimeOptions},
    types::{Content, Memory, UUID},
    IMessageService,
};
use elizaos_plugin_openai::create_openai_elizaos_plugin;
use std::io::{self, Write};

#[tokio::main]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();

    let character = parse_character(r#"{"name": "Eliza", "bio": "A helpful AI assistant.", "system": "You are helpful and concise."}"#)?;

    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(character.clone()),
        plugins: vec![create_openai_elizaos_plugin()?],
        ..Default::default()
    }).await?;

    runtime.initialize().await?;

    let (user_id, room_id) = (UUID::new_v4(), UUID::new_v4());

    loop {
        print!("You: ");
        io::stdout().flush()?;

        let mut input = String::new();
        if io::stdin().read_line(&mut input)? == 0 { break }

        if matches!(input.to_lowercase().as_str(), "quit" | "exit") { break }

        let content = Content { text: Some(input.into()), ..Default::default() };
        let mut message = Memory::new(user_id.clone(), room_id.clone(), content);

        let result = runtime.message_service().handle_message(&runtime, &mut message, None, None).await?;

        if let Some(text) = result.response_content.and_then(|c| c.text) {
            println!("\n{}: {}\n", character.name, text);
        }
    }

    runtime.stop().await?;
    println!("Goodbye! 👋");
    Ok(())
}
