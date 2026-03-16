#![allow(missing_docs)]

use crate::actions::SayAloudAction;
use crate::services::SamTTSService;

pub struct SimpleVoicePlugin {
    pub name: &'static str,
    pub description: &'static str,
    pub actions: Vec<SayAloudAction>,
}

impl SimpleVoicePlugin {
    pub fn new() -> Self {
        Self {
            name: "@elizaos/plugin-simple-voice",
            description: "Retro text-to-speech using SAM Speech Synthesizer",
            actions: vec![SayAloudAction::new()],
        }
    }

    pub fn service_type() -> &'static str {
        SamTTSService::SERVICE_TYPE
    }

    pub fn create_service() -> SamTTSService {
        SamTTSService::default()
    }
}

impl Default for SimpleVoicePlugin {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_correct_metadata() {
        let plugin = SimpleVoicePlugin::new();
        assert_eq!(plugin.name, "@elizaos/plugin-simple-voice");
        assert!(plugin.description.contains("SAM"));
    }

    #[test]
    fn registers_action() {
        let plugin = SimpleVoicePlugin::new();
        assert_eq!(plugin.actions.len(), 1);
        assert_eq!(plugin.actions[0].name, "SAY_ALOUD");
    }

    #[test]
    fn creates_service() {
        let service = SimpleVoicePlugin::create_service();
        assert!(service.capability_description().contains("SAM"));
    }
}
