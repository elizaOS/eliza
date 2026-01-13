//! elizaOS Rust Adventure Game Demo
//!
//! A text adventure game where an AI agent (powered by elizaOS) explores a dungeon,
//! making decisions about which actions to take. Demonstrates:
//! - elizaOS runtime with plugins
//! - OpenAI integration for AI decision making
//! - Custom game actions
//! - State management
//!
//! Usage:
//!   OPENAI_API_KEY=your_key cargo run --bin adventure-game
//!
//! To suppress logs:
//!   LOG_LEVEL=fatal OPENAI_API_KEY=your_key cargo run --bin adventure-game

use anyhow::Result;
use console::{style, Term};
use dialoguer::{theme::ColorfulTheme, Select};
use elizaos::{
    runtime::{AgentRuntime, RuntimeOptions},
    types::{Bio, ChannelType, Character, Content, Memory, UUID},
    IMessageService,
};
use elizaos_plugin_openai::create_openai_elizaos_plugin;
use std::collections::HashMap;
use std::io::{self, Write};
use tokio::time::{sleep, Duration};

// ============================================================================
// GAME WORLD DEFINITION
// ============================================================================

#[derive(Clone, Debug)]
struct Item {
    id: String,
    name: String,
    description: String,
    usable: bool,
}

#[derive(Clone, Debug)]
struct Enemy {
    name: String,
    health: i32,
    damage: i32,
    description: String,
    defeated_message: String,
}

#[derive(Clone, Debug)]
struct Room {
    id: String,
    name: String,
    description: String,
    exits: HashMap<String, String>,
    items: Vec<Item>,
    enemy: Option<Enemy>,
    visited: bool,
}

#[derive(Clone, Debug)]
struct GameState {
    current_room: String,
    inventory: Vec<Item>,
    health: i32,
    max_health: i32,
    score: i32,
    turns_played: i32,
    game_over: bool,
    victory: bool,
}

impl Default for GameState {
    fn default() -> Self {
        Self {
            current_room: "entrance".to_string(),
            inventory: Vec::new(),
            health: 100,
            max_health: 100,
            score: 0,
            turns_played: 0,
            game_over: false,
            victory: false,
        }
    }
}

fn create_items() -> HashMap<String, Item> {
    let mut items = HashMap::new();

    items.insert(
        "torch".to_string(),
        Item {
            id: "torch".to_string(),
            name: "Rusty Torch".to_string(),
            description: "A flickering torch that casts dancing shadows".to_string(),
            usable: true,
        },
    );
    items.insert(
        "key".to_string(),
        Item {
            id: "key".to_string(),
            name: "Golden Key".to_string(),
            description: "An ornate key with strange symbols".to_string(),
            usable: true,
        },
    );
    items.insert(
        "sword".to_string(),
        Item {
            id: "sword".to_string(),
            name: "Ancient Sword".to_string(),
            description: "A weathered but sharp blade".to_string(),
            usable: true,
        },
    );
    items.insert(
        "potion".to_string(),
        Item {
            id: "potion".to_string(),
            name: "Health Potion".to_string(),
            description: "A glowing red liquid that restores health".to_string(),
            usable: true,
        },
    );
    items.insert(
        "treasure".to_string(),
        Item {
            id: "treasure".to_string(),
            name: "Dragon's Treasure".to_string(),
            description: "A chest overflowing with gold and gems".to_string(),
            usable: false,
        },
    );

    items
}

fn create_enemies() -> HashMap<String, Enemy> {
    let mut enemies = HashMap::new();

    enemies.insert(
        "goblin".to_string(),
        Enemy {
            name: "Cave Goblin".to_string(),
            health: 30,
            damage: 10,
            description: "A snarling goblin blocks your path, brandishing a crude club".to_string(),
            defeated_message: "The goblin crumples to the ground, defeated!".to_string(),
        },
    );
    enemies.insert(
        "skeleton".to_string(),
        Enemy {
            name: "Skeletal Guardian".to_string(),
            health: 40,
            damage: 15,
            description: "Ancient bones rattle as a skeleton warrior rises to face you".to_string(),
            defeated_message: "The skeleton collapses into a pile of bones!".to_string(),
        },
    );
    enemies.insert(
        "dragon".to_string(),
        Enemy {
            name: "Ancient Dragon".to_string(),
            health: 100,
            damage: 25,
            description: "A massive dragon guards its treasure, smoke curling from its nostrils"
                .to_string(),
            defeated_message: "With a final roar, the dragon falls! The treasure is yours!"
                .to_string(),
        },
    );

    enemies
}

fn create_game_world() -> HashMap<String, Room> {
    let items = create_items();
    let enemies = create_enemies();
    let mut world = HashMap::new();

    world.insert(
        "entrance".to_string(),
        Room {
            id: "entrance".to_string(),
            name: "Dungeon Entrance".to_string(),
            description: "You stand at the entrance of a dark dungeon. Cold air flows from within, \
                         carrying whispers of adventure and danger. Stone steps lead down into darkness."
                .to_string(),
            exits: [("north".to_string(), "hallway".to_string())]
                .into_iter()
                .collect(),
            items: vec![items["torch"].clone()],
            enemy: None,
            visited: false,
        },
    );

    world.insert(
        "hallway".to_string(),
        Room {
            id: "hallway".to_string(),
            name: "Torch-lit Hallway".to_string(),
            description: "A long hallway stretches before you, ancient torches casting flickering \
                         light on the stone walls. Cobwebs hang from the ceiling."
                .to_string(),
            exits: [
                ("south".to_string(), "entrance".to_string()),
                ("north".to_string(), "chamber".to_string()),
                ("east".to_string(), "armory".to_string()),
            ]
            .into_iter()
            .collect(),
            items: vec![],
            enemy: Some(enemies["goblin"].clone()),
            visited: false,
        },
    );

    world.insert(
        "armory".to_string(),
        Room {
            id: "armory".to_string(),
            name: "Abandoned Armory".to_string(),
            description: "Rusted weapons line the walls of this forgotten armory. \
                         Most are beyond use, but something glints in the corner."
                .to_string(),
            exits: [("west".to_string(), "hallway".to_string())]
                .into_iter()
                .collect(),
            items: vec![items["sword"].clone(), items["potion"].clone()],
            enemy: None,
            visited: false,
        },
    );

    world.insert(
        "chamber".to_string(),
        Room {
            id: "chamber".to_string(),
            name: "Central Chamber".to_string(),
            description: "A vast underground chamber with a domed ceiling. \
                         Three passages branch off into darkness. A locked door stands to the north."
                .to_string(),
            exits: [
                ("south".to_string(), "hallway".to_string()),
                ("east".to_string(), "crypt".to_string()),
                ("west".to_string(), "library".to_string()),
                ("north".to_string(), "throne".to_string()),
            ]
            .into_iter()
            .collect(),
            items: vec![],
            enemy: Some(enemies["skeleton"].clone()),
            visited: false,
        },
    );

    world.insert(
        "library".to_string(),
        Room {
            id: "library".to_string(),
            name: "Ancient Library".to_string(),
            description: "Dusty tomes fill towering shelves. The air smells of old paper \
                         and forgotten knowledge. A golden key lies on a reading table."
                .to_string(),
            exits: [("east".to_string(), "chamber".to_string())]
                .into_iter()
                .collect(),
            items: vec![items["key"].clone()],
            enemy: None,
            visited: false,
        },
    );

    world.insert(
        "crypt".to_string(),
        Room {
            id: "crypt".to_string(),
            name: "Dark Crypt".to_string(),
            description:
                "Stone sarcophagi line the walls of this burial chamber. The silence is oppressive."
                    .to_string(),
            exits: [("west".to_string(), "chamber".to_string())]
                .into_iter()
                .collect(),
            items: vec![items["potion"].clone()],
            enemy: None,
            visited: false,
        },
    );

    world.insert(
        "throne".to_string(),
        Room {
            id: "throne".to_string(),
            name: "Dragon's Throne Room".to_string(),
            description: "A massive cavern dominated by an ancient throne. \
                         Piles of gold and gems surround it. This is the dragon's lair!"
                .to_string(),
            exits: [("south".to_string(), "chamber".to_string())]
                .into_iter()
                .collect(),
            items: vec![items["treasure"].clone()],
            enemy: Some(enemies["dragon"].clone()),
            visited: false,
        },
    );

    world
}

// ============================================================================
// GAME ENGINE
// ============================================================================

struct AdventureGame {
    world: HashMap<String, Room>,
    state: GameState,
}

impl AdventureGame {
    fn new() -> Self {
        Self {
            world: create_game_world(),
            state: GameState::default(),
        }
    }

    fn get_state(&self) -> GameState {
        self.state.clone()
    }

    fn get_current_room(&self) -> &Room {
        self.world.get(&self.state.current_room).unwrap()
    }

    fn get_current_room_mut(&mut self) -> &mut Room {
        self.world.get_mut(&self.state.current_room).unwrap()
    }

    fn get_available_actions(&self) -> Vec<String> {
        let room = self.get_current_room();
        let mut actions = Vec::new();

        // Movement
        for direction in room.exits.keys() {
            // Check if north requires key for throne room
            if direction == "north" && room.id == "chamber" {
                if self.state.inventory.iter().any(|i| i.id == "key") {
                    actions.push(format!("go {}", direction));
                }
            } else {
                actions.push(format!("go {}", direction));
            }
        }

        // Pick up items
        for item in &room.items {
            actions.push(format!("take {}", item.name.to_lowercase()));
        }

        // Combat
        if let Some(enemy) = &room.enemy {
            if enemy.health > 0 {
                actions.push("attack".to_string());
                if self.state.inventory.iter().any(|i| i.id == "sword") {
                    actions.push("attack with sword".to_string());
                }
            }
        }

        // Use items
        for item in &self.state.inventory {
            if item.usable {
                actions.push(format!("use {}", item.name.to_lowercase()));
            }
        }

        // Always available
        actions.push("look around".to_string());
        actions.push("check inventory".to_string());

        actions
    }

    fn execute_action(&mut self, action: &str) -> String {
        self.state.turns_played += 1;
        let action_lower = action.to_lowercase();

        // Movement
        if action_lower.starts_with("go ") {
            return self.handle_move(&action_lower[3..]);
        }

        // Take item
        if action_lower.starts_with("take ") {
            return self.handle_take(&action_lower[5..]);
        }
        if action_lower.starts_with("pick up ") {
            return self.handle_take(&action_lower[8..]);
        }

        // Attack
        if action_lower.starts_with("attack") {
            let with_sword = action_lower.contains("sword");
            return self.handle_attack(with_sword);
        }

        // Use item
        if action_lower.starts_with("use ") {
            return self.handle_use(&action_lower[4..]);
        }

        // Look around
        if action_lower == "look around" || action_lower == "look" {
            return self.describe_room();
        }

        // Check inventory
        if action_lower == "check inventory" || action_lower == "inventory" || action_lower == "i" {
            return self.describe_inventory();
        }

        format!(
            "I don't understand \"{}\". Try one of the available actions.",
            action
        )
    }

    fn handle_move(&mut self, direction: &str) -> String {
        let room = self.get_current_room().clone();

        // Check for locked door
        if direction == "north"
            && room.id == "chamber"
            && !self.state.inventory.iter().any(|i| i.id == "key")
        {
            return "The door to the north is locked. You need a key to proceed.".to_string();
        }

        // Check for enemies blocking the path
        if let Some(enemy) = &room.enemy {
            if enemy.health > 0 && direction != "south" {
                return format!(
                    "The {} blocks your path! You must defeat it first or retreat south.",
                    enemy.name
                );
            }
        }

        if let Some(next_room_id) = room.exits.get(direction) {
            // Use key if going to throne room
            if direction == "north" && room.id == "chamber" {
                if let Some(idx) = self.state.inventory.iter().position(|i| i.id == "key") {
                    self.state.inventory.remove(idx);
                }
            }

            self.state.current_room = next_room_id.clone();
            let new_room = self.get_current_room_mut();
            let first_visit = !new_room.visited;
            new_room.visited = true;

            if first_visit {
                self.state.score += 10;
            }

            let room_desc = self.describe_room();
            let mut result = format!("You move {}.\n\n{}", direction, room_desc);

            let room = self.get_current_room();
            if let Some(enemy) = &room.enemy {
                if enemy.health > 0 {
                    result.push_str(&format!("\n\n⚔️ DANGER! {}", enemy.description));
                }
            }

            return result;
        }

        format!("You cannot go {} from here.", direction)
    }

    fn handle_take(&mut self, item_name: &str) -> String {
        let room = self.get_current_room_mut();
        let item_idx = room
            .items
            .iter()
            .position(|i| i.name.to_lowercase().contains(&item_name.to_lowercase()));

        if let Some(idx) = item_idx {
            let item = room.items.remove(idx);
            let result = format!("You pick up the {}. {}", item.name, item.description);
            self.state.inventory.push(item);
            self.state.score += 5;
            return result;
        }

        format!("There is no \"{}\" here to take.", item_name)
    }

    fn handle_attack(&mut self, with_sword: bool) -> String {
        // First check if there's an enemy to attack
        let room = self.get_current_room();
        let has_enemy = room.enemy.as_ref().map_or(false, |e| e.health > 0);
        if !has_enemy {
            return "There is nothing to attack here.".to_string();
        }

        let player_damage = if with_sword { 35 } else { 15 };
        let weapon_text = if with_sword {
            "strike with your ancient sword"
        } else {
            "punch with your fists"
        };

        // Now mutably borrow and update
        let room = self.get_current_room_mut();
        let enemy = room.enemy.as_mut().unwrap();
        enemy.health -= player_damage;

        // Extract needed values before dropping borrow
        let enemy_dead = enemy.health <= 0;
        let enemy_defeated_msg = enemy.defeated_message.clone();
        let enemy_name = enemy.name.clone();
        let enemy_damage = enemy.damage;
        let enemy_health = enemy.health;
        let is_dragon = enemy_name == "Ancient Dragon";

        let mut result = format!("You {}, dealing {} damage!", weapon_text, player_damage);

        if enemy_dead {
            result.push_str(&format!("\n\n🎉 {}", enemy_defeated_msg));
            self.state.score += 50;

            // Victory condition: defeating the dragon
            if is_dragon {
                self.state.victory = true;
                self.state.game_over = true;
                self.state.score += 200;
                result.push_str(
                    "\n\n🏆 VICTORY! You have conquered the dungeon and claimed the dragon's treasure!",
                );
                result.push_str(&format!(
                    "\n\nFinal Score: {} points in {} turns.",
                    self.state.score, self.state.turns_played
                ));
            }
        } else {
            // Enemy counterattacks
            self.state.health -= enemy_damage;
            result.push_str(&format!(
                "\nThe {} strikes back for {} damage!",
                enemy_name, enemy_damage
            ));
            result.push_str(&format!(
                "\nYour health: {}/{} | Enemy health: {}",
                self.state.health, self.state.max_health, enemy_health
            ));

            if self.state.health <= 0 {
                self.state.game_over = true;
                result.push_str(&format!(
                    "\n\n💀 GAME OVER! You have been defeated by the {}.",
                    enemy_name
                ));
                result.push_str(&format!(
                    "\n\nFinal Score: {} points in {} turns.",
                    self.state.score, self.state.turns_played
                ));
            }
        }

        result
    }

    fn handle_use(&mut self, item_name: &str) -> String {
        let item_idx = self
            .state
            .inventory
            .iter()
            .position(|i| i.name.to_lowercase().contains(&item_name.to_lowercase()));

        let idx = match item_idx {
            Some(i) => i,
            None => return format!("You don't have \"{}\" in your inventory.", item_name),
        };

        let item = &self.state.inventory[idx];

        match item.id.as_str() {
            "potion" => {
                let heal_amount = (50).min(self.state.max_health - self.state.health);
                self.state.health += heal_amount;
                self.state.inventory.remove(idx);
                format!(
                    "You drink the health potion and restore {} health! Health: {}/{}",
                    heal_amount, self.state.health, self.state.max_health
                )
            }
            "torch" => {
                "The torch illuminates your surroundings. You can see more clearly now.".to_string()
            }
            "key" => "The key looks like it would fit a large lock. Perhaps there's a locked door somewhere.".to_string(),
            "sword" => "You swing the ancient sword through the air. It feels well-balanced and deadly.".to_string(),
            _ => format!("You can't use the {} right now.", item.name),
        }
    }

    fn describe_room(&self) -> String {
        let room = self.get_current_room();
        let mut description = format!("📍 {}\n\n{}", room.name, room.description);

        if !room.items.is_empty() {
            let item_names: Vec<_> = room.items.iter().map(|i| i.name.clone()).collect();
            description.push_str(&format!("\n\n📦 Items here: {}", item_names.join(", ")));
        }

        let exits: Vec<_> = room.exits.keys().cloned().collect();
        description.push_str(&format!("\n\n🚪 Exits: {}", exits.join(", ")));

        if room.id == "chamber" && !self.state.inventory.iter().any(|i| i.id == "key") {
            description.push_str("\n(The door to the north is locked)");
        }

        description
    }

    fn describe_inventory(&self) -> String {
        if self.state.inventory.is_empty() {
            return "🎒 Your inventory is empty.".to_string();
        }

        let items: Vec<_> = self
            .state
            .inventory
            .iter()
            .map(|i| format!("  - {}: {}", i.name, i.description))
            .collect();

        format!(
            "🎒 Inventory:\n{}\n\n❤️ Health: {}/{} | ⭐ Score: {}",
            items.join("\n"),
            self.state.health,
            self.state.max_health,
            self.state.score
        )
    }

    fn get_status_line(&self) -> String {
        format!(
            "❤️ {}/{} | ⭐ {} | 🔄 Turn {}",
            self.state.health, self.state.max_health, self.state.score, self.state.turns_played
        )
    }
}

// ============================================================================
// AI AGENT INTEGRATION
// ============================================================================

struct GameSession {
    runtime: AgentRuntime,
    game: AdventureGame,
    room_id: uuid::Uuid,
    game_master_id: uuid::Uuid,
}

/// Convert a string to a deterministic UUID (matching TypeScript's stringToUuid)
fn string_to_uuid(input: &str) -> uuid::Uuid {
    uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_DNS, input.as_bytes())
}

async fn create_session() -> Result<GameSession> {
    println!("🚀 Initializing adventure...");

    // Load environment variables
    let _ = dotenvy::dotenv();

    // Create character
    let character = Character {
        name: "Eliza the Adventurer".to_string(),
        username: Some("eliza_adventurer".to_string()),
        bio: Bio::Multiple(vec![
            "A brave AI adventurer exploring dangerous dungeons.".to_string(),
            "Known for clever problem-solving and careful exploration.".to_string(),
            "Prefers to be well-prepared before combat.".to_string(),
        ]),
        system: Some("You are a strategic adventurer in a text adventure game.".to_string()),
        ..Default::default()
    };

    // Create runtime with plugins
    // action_planning: false ensures only one action is executed per turn,
    // which is critical for game scenarios where state changes after each action
    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(character),
        plugins: vec![create_openai_elizaos_plugin()?],
        action_planning: Some(false), // Single action per turn for game state consistency
        ..Default::default()
    })
    .await?;

    runtime.initialize().await?;

    let game = AdventureGame::new();
    let room_id = string_to_uuid("adventure-game-room");
    let game_master_id = string_to_uuid("dungeon-master");

    println!("✅ Adventure ready!");

    Ok(GameSession {
        runtime,
        game,
        room_id,
        game_master_id,
    })
}

async fn decide_action(session: &mut GameSession) -> Result<String> {
    let game = &session.game;
    let runtime = &session.runtime;

    let state = game.get_state();
    let room = game.get_current_room();
    let actions = game.get_available_actions();

    // Build enemy info
    let enemy_info = match &room.enemy {
        Some(e) if e.health > 0 => {
            format!("⚠️ ENEMY PRESENT: {} (Health: {})", e.name, e.health)
        }
        _ => String::new(),
    };

    let inventory_str = if state.inventory.is_empty() {
        "empty".to_string()
    } else {
        state
            .inventory
            .iter()
            .map(|i| i.name.clone())
            .collect::<Vec<_>>()
            .join(", ")
    };

    let actions_str = actions
        .iter()
        .enumerate()
        .map(|(i, a)| format!("{}. {}", i + 1, a))
        .collect::<Vec<_>>()
        .join("\n");

    let room_desc = game.describe_room();

    // Build the game state message from the Dungeon Master
    let game_context = format!(
        r#"DUNGEON MASTER UPDATE:

GAME STATE:
- Location: {}
- Health: {}/{}
- Inventory: {}
- Score: {}
- Turn: {}

CURRENT SCENE:
{}

{}

AVAILABLE ACTIONS:
{}

INSTRUCTIONS:
You are playing a text adventure game. Your goal is to explore the dungeon, collect items, defeat enemies, and find the dragon's treasure.

Think strategically:
- Explore to find items and the key before facing the dragon
- Pick up weapons (sword) before combat
- Use health potions when low on health
- The dragon is the final boss - be prepared!

Based on the current situation, choose the best action. Consider:
- If there's an enemy, do you have a weapon? Should you fight or flee?
- Are there useful items to pick up?
- Have you explored all areas?
- Is your health low? Do you have healing items?

Respond with ONLY the exact action text you want to take (e.g., "go north" or "attack with sword").
"#,
        room.name,
        state.health,
        state.max_health,
        inventory_str,
        state.score,
        state.turns_played,
        room_desc,
        enemy_info,
        actions_str
    );

    // Route through the full message pipeline (planning/actions/providers/memory)
    let content = Content {
        text: Some(game_context),
        source: Some("dungeon-master".to_string()),
        channel_type: Some(ChannelType::Dm),
        ..Default::default()
    };

    let mut message = Memory::new(
        UUID::from(session.game_master_id),
        UUID::from(session.room_id),
        content,
    );

    let result = runtime
        .message_service()
        .handle_message(runtime, &mut message, None, None)
        .await?;

    let chosen_action = result
        .response_content
        .and_then(|c| c.text)
        .unwrap_or_else(|| "look around".to_string());

    // Validate the action is in available actions (case-insensitive match)
    if let Some(matched) = actions
        .iter()
        .find(|a| a.eq_ignore_ascii_case(&chosen_action))
    {
        return Ok(matched.clone());
    }

    // Try to find a partial match
    if let Some(partial) = actions.iter().find(|a| {
        a.to_lowercase().contains(&chosen_action.to_lowercase())
            || chosen_action.to_lowercase().contains(&a.to_lowercase())
    }) {
        return Ok(partial.clone());
    }

    // Default to looking around if no valid action found
    Ok("look around".to_string())
}

// ============================================================================
// GAME DISPLAY
// ============================================================================

fn show_intro() {
    println!("\n🏰 elizaOS Adventure Game Demo");
    println!(
        r#"
╔════════════════════════════════════════════════════════════════════╗
║                   THE DUNGEON OF DOOM                              ║
╠════════════════════════════════════════════════════════════════════╣
║  Watch as Eliza the AI Adventurer explores a dangerous dungeon!    ║
║                                                                    ║
║  The AI will:                                                      ║
║  • Explore rooms and collect items                                 ║
║  • Fight monsters using strategic decisions                        ║
║  • Manage health and inventory                                     ║
║  • Seek the dragon's treasure!                                     ║
║                                                                    ║
║  AI: OpenAI via elizaos-plugin-openai                              ║
╚════════════════════════════════════════════════════════════════════╝
"#
    );
}

fn show_turn(turn_number: i32, action: &str) {
    println!("\n{}", "═".repeat(60));
    println!("🎮 TURN {}", turn_number);
    println!("{}", "─".repeat(60));
    println!("🤖 Eliza decides: \"{}\"", action);
    println!("{}", "─".repeat(60));
}

fn show_result(result: &str, status: &str) {
    println!("{}", result);
    println!("\n{}", status);
}

fn show_game_over(victory: bool, score: i32, turns: i32) {
    println!("\n{}", "═".repeat(60));
    if victory {
        println!(
            "{}",
            style("🏆 VICTORY! Eliza has conquered the dungeon!")
                .green()
                .bold()
        );
    } else {
        println!(
            "{}",
            style("💀 GAME OVER! Eliza has fallen...").red().bold()
        );
    }
    println!("Final Score: {} points in {} turns", score, turns);
    println!("{}\n", "═".repeat(60));
}

// ============================================================================
// MAIN GAME LOOP
// ============================================================================

async fn run_adventure_game() -> Result<()> {
    show_intro();

    let mut session = create_session().await?;

    // Show initial room
    println!("\n📜 The adventure begins...\n");
    println!("{}", session.game.describe_room());

    let delay_ms = 2000; // Delay between turns for readability

    while !session.game.get_state().game_over {
        // Get AI's decision
        let action = decide_action(&mut session).await?;

        // Display and execute the action
        show_turn(session.game.get_state().turns_played + 1, &action);

        let result = session.game.execute_action(&action);
        show_result(&result, &session.game.get_status_line());

        // Small delay for readability
        sleep(Duration::from_millis(delay_ms)).await;

        // Safety limit
        if session.game.get_state().turns_played > 100 {
            println!("\n⏰ Game exceeded 100 turns. Ending...");
            break;
        }
    }

    let final_state = session.game.get_state();
    show_game_over(
        final_state.victory,
        final_state.score,
        final_state.turns_played,
    );

    session.runtime.stop().await?;
    println!("Thanks for watching! 🎮");

    Ok(())
}

async fn run_interactive_mode() -> Result<()> {
    show_intro();

    let mut session = create_session().await?;

    println!("\n📜 INTERACTIVE MODE: Guide Eliza through the dungeon!\n");
    println!("You can type actions yourself, or type 'ai' to let Eliza decide.\n");
    println!("{}", session.game.describe_room());

    let stdin = io::stdin();

    while !session.game.get_state().game_over {
        println!("\n{}", session.game.get_status_line());
        println!(
            "Available actions: {}",
            session.game.get_available_actions().join(", ")
        );

        print!("Your command (or 'ai' for AI choice, 'quit' to exit): ");
        io::stdout().flush()?;

        let mut input = String::new();
        if stdin.read_line(&mut input)? == 0 {
            break;
        }

        let input = input.trim();
        if input.is_empty()
            || input.eq_ignore_ascii_case("quit")
            || input.eq_ignore_ascii_case("exit")
        {
            break;
        }

        let action = if input.eq_ignore_ascii_case("ai") {
            println!("Eliza is thinking...");
            let action = decide_action(&mut session).await?;
            println!("Eliza chooses: \"{}\"", action);
            action
        } else {
            input.to_string()
        };

        let result = session.game.execute_action(&action);
        println!("\n{}", result);
    }

    let final_state = session.game.get_state();
    if final_state.game_over {
        show_game_over(
            final_state.victory,
            final_state.score,
            final_state.turns_played,
        );
    }

    session.runtime.stop().await?;
    println!("Thanks for playing! 🎮");

    Ok(())
}

// ============================================================================
// ENTRY POINT
// ============================================================================

#[tokio::main]
async fn main() -> Result<()> {
    // Load environment variables
    let _ = dotenvy::dotenv();

    let term = Term::stdout();
    term.clear_screen()?;

    let selection = Select::with_theme(&ColorfulTheme::default())
        .with_prompt("Choose game mode")
        .items(&[
            "Watch AI Play - Eliza plays automatically",
            "Interactive - Guide Eliza or play yourself",
        ])
        .default(0)
        .interact()?;

    match selection {
        0 => run_adventure_game().await,
        1 => run_interactive_mode().await,
        _ => Ok(()),
    }
}
