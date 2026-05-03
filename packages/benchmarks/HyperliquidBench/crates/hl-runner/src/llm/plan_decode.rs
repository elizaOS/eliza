use anyhow::{anyhow, Context, Result};
use hl_common::plan::Plan;
use serde_json::{json, Value};

pub fn decode_plan(raw: &str, max_steps: u32) -> Result<Plan> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(anyhow!("LLM response was empty"));
    }

    let candidates = generate_candidates(raw);
    let mut last_err: Option<anyhow::Error> = None;
    for candidate in candidates {
        match parse_plan_candidate(&candidate, max_steps) {
            Ok(plan) => return Ok(plan),
            Err(err) => {
                let message = err.to_string();
                if message.contains("max allowed") {
                    return Err(anyhow!(
                        "failed to decode plan from LLM response: {message}"
                    ));
                }
                last_err = Some(err);
            }
        }
    }

    match last_err {
        Some(err) => Err(anyhow!("failed to decode plan from LLM response: {err}")),
        None => Err(anyhow!("failed to decode plan from LLM response")),
    }
}

fn parse_plan_candidate(candidate: &str, max_steps: u32) -> Result<Plan> {
    let value: Value = serde_json::from_str(candidate)
        .with_context(|| "candidate JSON failed to parse".to_string())?;

    let root = if value.get("steps").is_some() {
        value
    } else if value.is_array() {
        json!({ "steps": value })
    } else {
        return Err(anyhow!("candidate JSON missing 'steps' array"));
    };

    let steps = root
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("'steps' is not an array"))?;

    if steps.is_empty() {
        return Err(anyhow!("plan must contain at least one step"));
    }
    if steps.len() as u32 > max_steps {
        return Err(anyhow!(
            "plan contains {} steps but max allowed is {}",
            steps.len(),
            max_steps
        ));
    }

    serde_json::from_value::<Plan>(root).with_context(|| "failed to deserialize plan".to_string())
}

fn generate_candidates(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    out.push(raw.trim().to_string());

    if let Some(blocks) = extract_code_blocks(raw) {
        out.extend(blocks);
    }

    if let Some(idx) = raw.find('{') {
        out.push(raw[idx..].trim().to_string());
    }
    if let Some(idx) = raw.find('[') {
        out.push(raw[idx..].trim().to_string());
    }

    out.into_iter()
        .filter(|candidate| candidate.starts_with('{') || candidate.starts_with('['))
        .collect()
}

fn extract_code_blocks(raw: &str) -> Option<Vec<String>> {
    let mut blocks = Vec::new();
    let mut remainder = raw;

    while let Some(start) = remainder.find("```") {
        remainder = &remainder[start + 3..];
        if let Some(end) = remainder.find("```") {
            let (lang_and_block, rest) = remainder.split_at(end);
            let block = lang_and_block
                .lines()
                .skip_while(|line| line.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            if let Some(idx) = block.find('{') {
                blocks.push(block[idx..].trim().to_string());
            } else if let Some(idx) = block.find('[') {
                blocks.push(block[idx..].trim().to_string());
            }
            remainder = &rest[3..];
        } else {
            break;
        }
    }

    if blocks.is_empty() {
        None
    } else {
        Some(blocks)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str) -> Result<Plan> {
        decode_plan(raw, 5)
    }

    #[test]
    fn parse_object() {
        let plan = parse(r#"{"steps": [{"sleep_ms": {"duration_ms": 100}}]}"#).unwrap();
        assert_eq!(plan.steps.len(), 1);
    }

    #[test]
    fn parse_array() {
        let plan = parse(r#"[{"sleep_ms": {"duration_ms": 200}}]"#).unwrap();
        assert_eq!(plan.steps.len(), 1);
    }

    #[test]
    fn parse_from_code_block() {
        let raw = "Here is the plan:\n```json\n{\n  \"steps\": [\n    { \"sleep_ms\": { \"duration_ms\": 100 } }\n  ]\n}\n```";
        let plan = parse(raw).unwrap();
        assert_eq!(plan.steps.len(), 1);
    }

    #[test]
    fn reject_too_many_steps() {
        let err = decode_plan(
            r#"{"steps":[{"sleep_ms":{"duration_ms":10}},{"sleep_ms":{"duration_ms":10}},{"sleep_ms":{"duration_ms":10}},{"sleep_ms":{"duration_ms":10}},{"sleep_ms":{"duration_ms":10}},{"sleep_ms":{"duration_ms":10}}]}"#,
            5,
        )
        .unwrap_err();
        assert!(err.to_string().contains("max allowed"));
    }
}
