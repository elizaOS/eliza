//! Tool bundle definitions

use crate::exceptions::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A command bundle defining a tool
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bundle {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_script: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub arguments: Vec<Argument>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

impl Bundle {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            end_name: None,
            install_script: None,
            signature: None,
            description: None,
            arguments: Vec::new(),
            extra: HashMap::new(),
        }
    }

    pub fn with_end_name(mut self, end_name: impl Into<String>) -> Self {
        self.end_name = Some(end_name.into());
        self
    }

    pub fn with_install_script(mut self, script: impl Into<String>) -> Self {
        self.install_script = Some(script.into());
        self
    }

    pub fn with_description(mut self, desc: impl Into<String>) -> Self {
        self.description = Some(desc.into());
        self
    }

    pub fn with_signature(mut self, sig: impl Into<String>) -> Self {
        self.signature = Some(sig.into());
        self
    }

    pub fn with_argument(mut self, arg: Argument) -> Self {
        self.arguments.push(arg);
        self
    }

    /// Generate documentation for this command
    pub fn generate_docs(&self) -> String {
        let mut docs = String::new();

        docs.push_str(&format!("## {}\n\n", self.name));

        if let Some(ref desc) = self.description {
            docs.push_str(&format!("{}\n\n", desc));
        }

        if let Some(ref sig) = self.signature {
            docs.push_str(&format!("**Signature:** `{}`\n\n", sig));
        }

        if !self.arguments.is_empty() {
            docs.push_str("**Arguments:**\n\n");
            for arg in &self.arguments {
                let required = if arg.required { " (required)" } else { "" };
                docs.push_str(&format!(
                    "- `{}`: {}{}\n",
                    arg.name,
                    arg.description.as_deref().unwrap_or(""),
                    required
                ));
            }
            docs.push('\n');
        }

        docs
    }
}

/// An argument for a command
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Argument {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arg_type: Option<String>,
}

impl Argument {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            description: None,
            required: false,
            default_value: None,
            arg_type: None,
        }
    }

    pub fn required(mut self) -> Self {
        self.required = true;
        self
    }

    pub fn with_description(mut self, desc: impl Into<String>) -> Self {
        self.description = Some(desc.into());
        self
    }

    pub fn with_default(mut self, default: impl Into<String>) -> Self {
        self.default_value = Some(default.into());
        self
    }

    pub fn with_type(mut self, arg_type: impl Into<String>) -> Self {
        self.arg_type = Some(arg_type.into());
        self
    }
}

/// Configuration for creating a bundle
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BundleConfig {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_script: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub arguments: Vec<Argument>,
}

/// Create a bundle from configuration
pub fn create_bundle(config: &BundleConfig) -> Result<Bundle> {
    let mut bundle = Bundle::new(&config.name);

    if let Some(ref end_name) = config.end_name {
        bundle = bundle.with_end_name(end_name);
    }

    if let Some(ref script) = config.install_script {
        bundle = bundle.with_install_script(script);
    }

    if let Some(ref sig) = config.signature {
        bundle = bundle.with_signature(sig);
    }

    if let Some(ref desc) = config.description {
        bundle = bundle.with_description(desc);
    }

    bundle.arguments = config.arguments.clone();

    Ok(bundle)
}

/// Generate documentation for all commands
pub fn generate_command_docs(bundles: &[Bundle]) -> String {
    let mut docs = String::new();
    docs.push_str("# Available Commands\n\n");

    for bundle in bundles {
        docs.push_str(&bundle.generate_docs());
    }

    docs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bundle_creation() {
        let bundle = Bundle::new("edit")
            .with_end_name("ENDEDIT")
            .with_description("Edit a file")
            .with_argument(
                Argument::new("file")
                    .required()
                    .with_description("The file to edit"),
            );

        assert_eq!(bundle.name, "edit");
        assert_eq!(bundle.end_name, Some("ENDEDIT".to_string()));
        assert_eq!(bundle.arguments.len(), 1);
    }

    #[test]
    fn test_generate_docs() {
        let bundle = Bundle::new("test")
            .with_description("A test command")
            .with_signature("test <arg>");

        let docs = bundle.generate_docs();
        assert!(docs.contains("## test"));
        assert!(docs.contains("A test command"));
    }
}
