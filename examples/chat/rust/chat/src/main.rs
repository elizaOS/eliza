use anyhow::Result;
use elizaos::{
    parse_character,
    runtime::{AgentRuntime, RuntimeOptions},
    services::IMessageService,
    types::{Content, Memory, UUID},
};
use elizaos_plugin_openai::create_openai_elizaos_plugin;
use std::io::{self, Write};

#[tokio::main]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();

    let character = parse_character(r#"{"name": "Eliza", "bio": "A knowledgeable and direct AI assistant who gives substantive answers.", "system": "You are a helpful, knowledgeable assistant. Give direct, substantive answers. Do NOT act like a therapist or the classic ELIZA chatbot. Never reflect questions back at the user or ask 'Why do you say that?' - just answer their questions and engage with what they're actually saying."}"#)?;

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
            // Strip any redundant "Name:" prefix the model may have included
            let clean_text = text
                .strip_prefix(&format!("{}: ", character.name))
                .or_else(|| text.strip_prefix(&format!("{}:", character.name)))
                .unwrap_or(&text)
                .trim();
            println!("\n{}: {}\n", character.name, clean_text);
        }
    }

    runtime.stop().await?;
    println!("Goodbye! 👋");
    Ok(())
}
