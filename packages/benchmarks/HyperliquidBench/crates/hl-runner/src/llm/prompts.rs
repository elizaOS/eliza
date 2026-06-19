use std::fmt::Write;

pub struct CoveragePrompt<'a> {
    pub max_steps: u32,
    pub allowed_coins: &'a [String],
    pub builder_code: Option<&'a str>,
    pub network: &'a str,
}

pub struct HianPrompt<'a> {
    pub max_steps: u32,
    pub allowed_coins: &'a [String],
    pub builder_code: Option<&'a str>,
    pub context: &'a str,
}

pub fn coverage_prompts(ctx: &CoveragePrompt<'_>) -> (String, String) {
    let mut system = String::new();
    writeln!(
        &mut system,
        "You are HyperLiquidBench's plan agent. You output short JSON plans for executing synthetic coverage tests on Hyperliquid {}.",
        ctx.network
    )
    .unwrap();
    system.push_str(
        "Return ONLY valid JSON that conforms to the provided schema. Do not include commentary, Markdown fences, code blocks, or explanations. Each step must be one of the allowed actions. Total steps must be <= the provided max.",
    );

    let mut user = String::new();
    writeln!(
        &mut user,
        "Generate a plan with at most {} steps that touches distinct venue actions for scoring coverage.",
        ctx.max_steps
    )
    .unwrap();
    writeln!(&mut user, "Allowed coins: {}", ctx.allowed_coins.join(", ")).unwrap();
    if let Some(code) = ctx.builder_code {
        writeln!(
            &mut user,
            "Use builderCode \"{}\" whenever you include orders unless a step supplies a more specific builderCode.",
            code
        )
        .unwrap();
    }
    user.push_str(
        r#"Schema (JSON):
{
  "steps": [
    {"perp_orders": {"orders": [{"coin": "ETH", "side": "buy"|"sell", "tif": "GTC"|"ALO"|"IOC", "sz": number, "reduceOnly": bool, "builderCode": string, "px": number|string, "trigger": {"kind": "none"}}], "builderCode": string}},
    {"cancel_last": {"coin": string}},
    {"cancel_oids": {"coin": string, "oids": [number]}},
    {"cancel_all":  {"coin": string}},
    {"usd_class_transfer": {"toPerp": bool, "usdc": number}},
    {"set_leverage": {"coin": string, "leverage": number, "cross": bool}},
    {"sleep_ms": {"duration_ms": number}}
  ]
}
Rules:
- Use only the allowed coins.
- Sizes must be positive and reasonably small (e.g., 0.001 to 1).
- Keep leverage between 1 and 20.
- "trigger.kind" must always be "none".
- Return compact JSON without comments.
"#,
    );

    (system, user)
}

pub fn hian_prompts(ctx: &HianPrompt<'_>) -> (String, String) {
    let mut system = String::new();
    system.push_str("You create minimal JSON plans for HyperLiquidBench to satisfy a specific HiaN (Haystack-in-a-Needle) instruction. Respond with valid JSON only.");

    let mut user = String::new();
    writeln!(&mut user, "Context:\n{}", ctx.context).unwrap();
    writeln!(&mut user, "\nInstructions:").unwrap();
    writeln!(&mut user, "- Produce at most {} steps.", ctx.max_steps).unwrap();
    writeln!(
        &mut user,
        "- Use only these coins: {}",
        ctx.allowed_coins.join(", ")
    )
    .unwrap();
    if let Some(code) = ctx.builder_code {
        writeln!(&mut user, "- Prefer builderCode \"{}\" for orders.", code).unwrap();
    }
    user.push_str(
        r#"- Follow the JSON schema described earlier (perp_orders, usd_class_transfer, cancel_*, set_leverage, sleep_ms).
- For perp_orders, supply "trigger": {"kind": "none"}.
- Output JSON only, no extra commentary.
"#,
    );

    (system, user)
}
