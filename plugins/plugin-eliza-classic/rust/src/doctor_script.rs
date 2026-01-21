#![allow(missing_docs)]

use serde::Deserialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize)]
pub struct DoctorScript {
    pub greetings: Vec<String>,
    pub goodbyes: Vec<String>,
    #[serde(rename = "default")]
    pub default_responses: Vec<String>,
    pub reflections: HashMap<String, String>,
    #[serde(default)]
    pub substitutions: HashMap<String, String>,
    pub groups: HashMap<String, Vec<String>>,
    pub keywords: Vec<KeywordEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KeywordEntry {
    pub keyword: Vec<String>,
    pub precedence: i32,
    pub rules: Vec<ScriptRule>,
    #[serde(default)]
    pub memory: Vec<ScriptRule>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ScriptRule {
    pub decomposition: String,
    pub reassembly: Vec<String>,
}

pub fn load_doctor_script() -> DoctorScript {
    // Keep Rust in sync with TS by using the shared canonical doctor.json.
    // The path is relative to this crate: rust/src/doctor_script.rs → ../../shared/doctor.json
    let raw = include_str!("../../shared/doctor.json");
    serde_json::from_str::<DoctorScript>(raw).expect("doctor.json must be valid")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn test_doctor_json_basic_integrity() {
        let script = load_doctor_script();
        assert!(!script.greetings.is_empty());
        assert!(!script.goodbyes.is_empty());
        assert!(!script.default_responses.is_empty());
        assert!(!script.keywords.is_empty());
        assert!(!script.groups.is_empty());
        assert!(!script.reflections.is_empty());
    }

    #[test]
    fn test_redirect_targets_exist() {
        let script = load_doctor_script();
        let mut keywords: HashSet<String> = HashSet::new();
        for k in &script.keywords {
            for w in &k.keyword {
                keywords.insert(w.to_lowercase());
            }
        }

        let mut missing: Vec<String> = Vec::new();
        for entry in &script.keywords {
            for rule in &entry.rules {
                for r in &rule.reassembly {
                    let t = r.trim();
                    if let Some(rest) = t.strip_prefix('=') {
                        let target = rest.trim().to_lowercase();
                        if !target.is_empty() && !keywords.contains(&target) {
                            missing.push(target);
                        }
                    }
                }
            }
        }
        missing.sort();
        missing.dedup();
        assert!(
            missing.is_empty(),
            "missing redirect targets: {:?}",
            missing
        );
    }
}
