use anyhow::Result;
use elizaos::{
    parse_character,
    runtime::{AgentRuntime, RuntimeOptions},
    types::{
        components::{ActionDefinition, ActionHandler, ActionResult, HandlerOptions},
        plugin::Plugin,
        primitives::Content,
        Memory, State, UUID,
    },
};
use elizaos::services::IMessageService;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, OnceLock},
};
use tokio::time::{sleep, Duration};

// ============================================================================
// WORLD STATE (single agent)
// ============================================================================

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct Pos {
    x: i32,
    y: i32,
}

#[derive(Clone, Debug)]
struct World {
    width: i32,
    height: i32,
    tick: i32,
    agent_pos: Pos,
    agent_energy: f32,
    agent_vision: i32,
    food: HashSet<Pos>,
}

impl World {
    fn new(width: i32, height: i32) -> Self {
        Self {
            width,
            height,
            tick: 0,
            agent_pos: Pos { x: 0, y: 0 },
            agent_energy: 60.0,
            agent_vision: 4,
            food: HashSet::new(),
        }
    }

    fn wrap(&self, v: i32, max: i32) -> i32 {
        ((v % max) + max) % max
    }

    fn dist(&self, a: Pos, b: Pos) -> f32 {
        let dx_raw = (a.x - b.x).abs();
        let dy_raw = (a.y - b.y).abs();
        let dx = dx_raw.min(self.width - dx_raw) as f32;
        let dy = dy_raw.min(self.height - dy_raw) as f32;
        (dx * dx + dy * dy).sqrt()
    }

    fn spawn_food(&mut self) {
        // deterministic-ish: use tick-based LCG (avoid external RNG deps)
        let mut s = (self.tick as u32).wrapping_mul(1103515245).wrapping_add(12345);
        let max_food = 50usize;
        if self.food.len() >= max_food {
            return;
        }
        let spawns = 2;
        for _ in 0..spawns {
            s = s.wrapping_mul(1103515245).wrapping_add(12345);
            let x = (s % (self.width as u32)) as i32;
            s = s.wrapping_mul(1103515245).wrapping_add(12345);
            let y = (s % (self.height as u32)) as i32;
            self.food.insert(Pos { x, y });
        }
    }

    fn render(&self) -> String {
        let mut out = String::new();
        out.push_str("\x1b[2J\x1b[H");
        for y in 0..self.height {
            for x in 0..self.width {
                let p = Pos { x, y };
                if self.agent_pos == p {
                    out.push('●');
                } else if self.food.contains(&p) {
                    out.push('🌱');
                } else {
                    out.push('·');
                }
            }
            out.push('\n');
        }
        out.push('\n');
        out.push_str(&format!(
            "Tick={}  Energy={}  Vision={}  Food={}\n",
            self.tick,
            self.agent_energy.round() as i32,
            self.agent_vision,
            self.food.len()
        ));
        out
    }
}

static WORLD_ARC: OnceLock<Arc<Mutex<World>>> = OnceLock::new();

fn world() -> Arc<Mutex<World>> {
    WORLD_ARC
        .get_or_init(|| Arc::new(Mutex::new(World::new(24, 14))))
        .clone()
}

// ============================================================================
// ACTIONS (execute through runtime.process_selected_actions)
// ============================================================================

struct EatAction;

#[async_trait::async_trait]
impl ActionHandler for EatAction {
    fn definition(&self) -> ActionDefinition {
        ActionDefinition {
            name: "EAT".to_string(),
            description: "Eat food at current position".to_string(),
            similes: Some(vec!["CONSUME".to_string(), "FEED".to_string()]),
            examples: None,
            priority: None,
            tags: None,
            parameters: None,
        }
    }

    async fn validate(&self, _message: &Memory, _state: Option<&State>) -> bool {
        let world_ref = world();
        let w = world_ref.lock().expect("world lock poisoned");
        w.food.contains(&w.agent_pos)
    }

    async fn handle(
        &self,
        _message: &Memory,
        _state: Option<&State>,
        _options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>> {
        let world_ref = world();
        let mut w = world_ref.lock().expect("world lock poisoned");
        let here = w.agent_pos;
        if w.food.remove(&here) {
            w.agent_energy += 18.0;
            Ok(Some(ActionResult::success_with_text("EAT")))
        } else {
            Ok(Some(ActionResult::failure("No food here")))
        }
    }
}

struct MoveTowardFoodAction;

#[async_trait::async_trait]
impl ActionHandler for MoveTowardFoodAction {
    fn definition(&self) -> ActionDefinition {
        ActionDefinition {
            name: "MOVE_TOWARD_FOOD".to_string(),
            description: "Move one step toward the nearest visible food".to_string(),
            similes: Some(vec!["SEEK_FOOD".to_string(), "FORAGE".to_string()]),
            examples: None,
            priority: None,
            tags: None,
            parameters: None,
        }
    }

    async fn validate(&self, _message: &Memory, _state: Option<&State>) -> bool {
        let world_ref = world();
        let w = world_ref.lock().expect("world lock poisoned");
        w.food.iter().any(|p| w.dist(w.agent_pos, *p) <= w.agent_vision as f32)
    }

    async fn handle(
        &self,
        _message: &Memory,
        _state: Option<&State>,
        _options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>> {
        let world_ref = world();
        let mut w = world_ref.lock().expect("world lock poisoned");
        let mut nearest: Option<Pos> = None;
        let mut best = f32::INFINITY;
        for p in &w.food {
            let d = w.dist(w.agent_pos, *p);
            if d <= w.agent_vision as f32 && d < best {
                best = d;
                nearest = Some(*p);
            }
        }
        let Some(target) = nearest else {
            return Ok(Some(ActionResult::failure("No visible food")));
        };

        let mut dx = target.x - w.agent_pos.x;
        let mut dy = target.y - w.agent_pos.y;
        if dx.abs() > w.width / 2 {
            dx = -dx.signum();
        }
        if dy.abs() > w.height / 2 {
            dy = -dy.signum();
        }

        w.agent_pos = Pos {
            x: w.wrap(w.agent_pos.x + dx.signum(), w.width),
            y: w.wrap(w.agent_pos.y + dy.signum(), w.height),
        };
        w.agent_energy -= 1.5;
        Ok(Some(ActionResult::success_with_text("MOVE_TOWARD_FOOD")))
    }
}

struct WanderAction;

#[async_trait::async_trait]
impl ActionHandler for WanderAction {
    fn definition(&self) -> ActionDefinition {
        ActionDefinition {
            name: "WANDER".to_string(),
            description: "Move randomly when nothing else is attractive".to_string(),
            similes: Some(vec!["ROAM".to_string(), "EXPLORE".to_string()]),
            examples: None,
            priority: None,
            tags: None,
            parameters: None,
        }
    }

    async fn validate(&self, _message: &Memory, _state: Option<&State>) -> bool {
        true
    }

    async fn handle(
        &self,
        _message: &Memory,
        _state: Option<&State>,
        _options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>> {
        let world_ref = world();
        let mut w = world_ref.lock().expect("world lock poisoned");
        // deterministic "random": based on tick
        let t = w.tick;
        let dx = match t % 3 {
            0 => -1,
            1 => 0,
            _ => 1,
        };
        let dy = match (t / 3) % 3 {
            0 => -1,
            1 => 0,
            _ => 1,
        };
        w.agent_pos = Pos {
            x: w.wrap(w.agent_pos.x + dx, w.width),
            y: w.wrap(w.agent_pos.y + dy, w.height),
        };
        w.agent_energy -= 0.75;
        Ok(Some(ActionResult::success_with_text("WANDER")))
    }
}

// ============================================================================
// RULE-BASED MODEL HANDLER (returns deterministic XML for DefaultMessageService)
// ============================================================================

fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn decision_xml(action: &str, thought: &str) -> String {
    format!(
        "<thought>{}</thought><actions>{}</actions><text>{}</text>",
        escape_xml(thought),
        escape_xml(action),
        escape_xml(action),
    )
}

fn parse_env_kv(prompt: &str) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    for line in prompt.lines() {
        let Some((k, v)) = line.split_once('=') else { continue };
        let key = k.trim().to_uppercase();
        let val = v.trim().to_string();
        if matches!(
            key.as_str(),
            "TICK" | "POS" | "ENERGY" | "VISION" | "FOOD_COUNT"
        ) {
            out.insert(key, val);
        }
    }
    out
}

fn decision_model_handler(world: Arc<Mutex<World>>) -> elizaos::types::plugin::ModelHandlerFn {
    Box::new(move |params: Value| {
        let world = world.clone();
        Box::pin(async move {
            let prompt = params
                .get("prompt")
                .and_then(|p| p.as_str())
                .unwrap_or("");
            let env = parse_env_kv(prompt);
            let w = world.lock().expect("world lock poisoned");

            if w.food.contains(&w.agent_pos) {
                return Ok(decision_xml("EAT", "Food is underfoot; eat now."));
            }
            let sees_food = w
                .food
                .iter()
                .any(|p| w.dist(w.agent_pos, *p) <= w.agent_vision as f32);
            if sees_food {
                let thought = format!(
                    "Visible food detected (food_count={}); moving toward it.",
                    env.get("FOOD_COUNT").map(String::as_str).unwrap_or("?")
                );
                return Ok(decision_xml("MOVE_TOWARD_FOOD", &thought));
            }

            let thought = format!(
                "No food visible; wandering. env_tick={}",
                env.get("TICK").map(String::as_str).unwrap_or("?")
            );
            Ok(decision_xml("WANDER", &thought))
        })
    })
}

// ============================================================================
// MAIN
// ============================================================================

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize world
    {
        let world_ref = world();
        let mut w = world_ref.lock().expect("world lock poisoned");
        w.agent_pos = Pos { x: 8, y: 6 };
        // seed some food
        w.food.insert(Pos { x: 2, y: 2 });
        w.food.insert(Pos { x: 16, y: 9 });
    }

    let character = parse_character(
        r#"{
  "name": "LifeAgent",
  "bio": "A tiny agent living in a grid world.",
  "system": "You are a survival agent in a grid world. Choose exactly one action.",
  "settings": { "CHECK_SHOULD_RESPOND": true, "ACTION_PLANNING": false }
}"#,
    )?;

    let mut plugin = Plugin::new(
        "game-of-life",
        "Rust Game-of-Life: rule-based model handler + actions (no LLM)",
    )
    .with_action(Arc::new(EatAction))
    .with_action(Arc::new(MoveTowardFoodAction))
    .with_action(Arc::new(WanderAction));

    plugin.model_handlers.insert(
        "TEXT_LARGE".to_string(),
        decision_model_handler(world()),
    );
    plugin.model_handlers.insert(
        "TEXT_SMALL".to_string(),
        decision_model_handler(world()),
    );

    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(character.clone()),
        plugins: vec![plugin],
        ..Default::default()
    })
    .await?;

    runtime.initialize().await?;

    let env_entity_id = UUID::new_v4();
    let room_id = UUID::new_v4();

    println!(
        "\n══════════════════════════════════════════════════════════════\n\
         ELIZAOS AGENTIC GAME OF LIFE (RUST)\n\
         - Each tick: runtime.message_service().handle_message(...)\n\
         - Decision: custom TEXT_LARGE handler returns deterministic XML\n\
         - Actions: EAT / MOVE_TOWARD_FOOD / WANDER\n\
         - No LLM calls\n\
         ══════════════════════════════════════════════════════════════\n"
    );

    for tick in 1..=120 {
        {
            let world_ref = world();
            let mut w = world_ref.lock().expect("world lock poisoned");
            w.tick = tick;
            w.spawn_food();
            // energy decay + death
            w.agent_energy -= 0.25;
            if w.agent_energy <= 0.0 {
                println!("\n💀 Agent died (energy depleted).");
                break;
            }

            print!("{}", w.render());
        }

        let env_text = {
            let world_ref = world();
            let w = world_ref.lock().expect("world lock poisoned");
            format!(
                "TICK={}\nPOS={},{}\nENERGY={}\nVISION={}\nFOOD_COUNT={}",
                w.tick,
                w.agent_pos.x,
                w.agent_pos.y,
                w.agent_energy.round() as i32,
                w.agent_vision,
                w.food.len()
            )
        };

        let content = Content {
            text: Some(env_text),
            source: Some("simulation".to_string()),
            ..Default::default()
        };
        let mut message = Memory::new(env_entity_id.clone(), room_id.clone(), content);

        // Canonical elizaOS entrypoint (no bypassing)
        let _ = runtime
            .message_service()
            .handle_message(&runtime, &mut message, None, None)
            .await?;

        sleep(Duration::from_millis(80)).await;
    }

    runtime.stop().await?;
    Ok(())
}

