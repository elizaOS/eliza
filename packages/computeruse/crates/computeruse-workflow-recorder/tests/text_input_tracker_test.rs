#[cfg(target_os = "windows")]
#[cfg(test)]
mod text_input_tracker_tests {
    use computeruse::element::{UIElement, UIElementAttributes, UIElementImpl};
    use computeruse::errors::AutomationError;
    use computeruse::platforms::windows::{FontStyle, HighlightHandle, TextPosition};
    use computeruse::{ClickResult, Locator, ScreenshotResult};
    use computeruse_workflow_recorder::structs::TextInputTracker;

    // A mock UIElement for testing purposes.
    #[derive(Clone, Debug)]
    struct MockUIElementImpl {
        text: String,
        name: String,
        role: String,
    }

    impl UIElementImpl for MockUIElementImpl {
        fn object_id(&self) -> usize {
            0
        }
        fn id(&self) -> Option<String> {
            None
        }
        fn role(&self) -> String {
            self.role.clone()
        }
        fn attributes(&self) -> UIElementAttributes {
            UIElementAttributes {
                role: self.role.clone(),
                name: Some(self.name.clone()),
                bounds: None, // Mock element doesn't provide bounds
                ..Default::default()
            }
        }
        fn name(&self) -> Option<String> {
            Some(self.name.clone())
        }
        fn get_text(&self, _max_depth: usize) -> Result<String, AutomationError> {
            Ok(self.text.clone())
        }
        fn children(&self) -> Result<Vec<UIElement>, AutomationError> {
            Ok(vec![])
        }
        fn parent(&self) -> Result<Option<UIElement>, AutomationError> {
            Ok(None)
        }
        fn bounds(&self) -> Result<(f64, f64, f64, f64), AutomationError> {
            Ok((0.0, 0.0, 0.0, 0.0))
        }
        fn click(&self) -> Result<ClickResult, AutomationError> {
            unimplemented!()
        }
        fn double_click(&self) -> Result<ClickResult, AutomationError> {
            unimplemented!()
        }
        fn right_click(&self) -> Result<(), AutomationError> {
            unimplemented!()
        }
        fn hover(&self) -> Result<(), AutomationError> {
            unimplemented!()
        }
        fn focus(&self) -> Result<(), AutomationError> {
            unimplemented!()
        }
        fn type_text(
            &self,
            _text: &str,
            _use_clipboard: bool,
            _try_focus_before: bool,
            _try_click_before: bool,
            _restore_focus: bool,
        ) -> Result<(), AutomationError> {
            unimplemented!()
        }
        fn press_key(
            &self,
            _key: &str,
            _try_focus_before: bool,
            _try_click_before: bool,
            _restore_focus: bool,
        ) -> Result<(), AutomationError> {
            unimplemented!()
        }
        fn set_value(&self, _value: &str) -> Result<(), AutomationError> {
            unimplemented!()
        }
        fn is_enabled(&self) -> Result<bool, AutomationError> {
            Ok(true)
        }
        fn is_visible(&self) -> Result<bool, AutomationError> {
            Ok(true)
        }
        fn is_focused(&self) -> Result<bool, AutomationError> {
            Ok(false)
        }
        fn perform_action(&self, _action: &str) -> Result<(), AutomationError> {
            unimplemented!()
        }
        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
        fn create_locator(
            &self,
            _selector: computeruse::selector::Selector,
        ) -> Result<Locator, AutomationError> {
            unimplemented!()
        }
        fn scroll(&self, _direction: &str, _amount: f64) -> Result<(), AutomationError> {
            unimplemented!()
        }
        fn activate_window(&self) -> Result<(), AutomationError> {
            unimplemented!()
        }
        fn minimize_window(&self) -> Result<(), AutomationError> {
            unimplemented!()
        }
        fn maximize_window(&self) -> Result<(), AutomationError> {
            unimplemented!()
        }
        fn maximize_window_keyboard(&self) -> Result<(), AutomationError> {
            unimplemented!()
        }
        fn minimize_window_keyboard(&self) -> Result<(), AutomationError> {
            unimplemented!()
        }
        fn get_native_window_handle(&self) -> Result<isize, AutomationError> {
            unimplemented!()
        }
        fn clone_box(&self) -> Box<dyn UIElementImpl> {
            Box::new(self.clone())
        }
        fn is_keyboard_focusable(&self) -> Result<bool, AutomationError> {
            Ok(true)
        }
        fn mouse_drag(
            &self,
            _start_x: f64,
            _start_y: f64,
            _end_x: f64,
            _end_y: f64,
        ) -> Result<(), AutomationError> {
            unimplemented!()
        }
        fn mouse_click_and_hold(&self, _x: f64, _y: f64) -> Result<(), AutomationError> {
            unimplemented!()
        }
        fn mouse_move(&self, _x: f64, _y: f64) -> Result<(), AutomationError> {
            unimplemented!()
        }
        fn mouse_release(&self) -> Result<(), AutomationError> {
            unimplemented!()
        }
        fn application(&self) -> Result<Option<UIElement>, AutomationError> {
            Ok(None)
        }
        fn window(&self) -> Result<Option<UIElement>, AutomationError> {
            Ok(None)
        }
        fn highlight(
            &self,
            _color: Option<u32>,
            _duration: Option<std::time::Duration>,
            _text: Option<&str>,
            _text_position: Option<TextPosition>,
            _font_style: Option<FontStyle>,
        ) -> Result<HighlightHandle, AutomationError> {
            unimplemented!()
        }
        fn set_transparency(&self, _percentage: u8) -> Result<(), AutomationError> {
            unimplemented!()
        }
        fn process_id(&self) -> Result<u32, AutomationError> {
            Ok(1)
        }
        fn capture(&self) -> Result<ScreenshotResult, AutomationError> {
            unimplemented!()
        }
        fn close(&self) -> Result<(), AutomationError> {
            unimplemented!()
        }
        fn url(&self) -> Option<String> {
            todo!()
        }
        fn select_option(&self, _option_name: &str) -> Result<(), AutomationError> {
            todo!()
        }
        fn list_options(&self) -> Result<Vec<String>, AutomationError> {
            todo!()
        }
        fn is_toggled(&self) -> Result<bool, AutomationError> {
            todo!()
        }
        fn set_toggled(&self, _state: bool) -> Result<(), AutomationError> {
            todo!()
        }
        fn get_range_value(&self) -> Result<f64, AutomationError> {
            todo!()
        }
        fn set_range_value(&self, _value: f64) -> Result<(), AutomationError> {
            todo!()
        }
        fn is_selected(&self) -> Result<bool, AutomationError> {
            Ok(false)
        }
        fn set_selected(&self, _state: bool) -> Result<(), AutomationError> {
            todo!()
        }
        fn invoke(&self) -> Result<(), AutomationError> {
            todo!()
        }
        fn get_value(&self) -> Result<Option<String>, AutomationError> {
            Ok(Some(self.text.clone()))
        }
    }

    fn create_tracker_with_text(text: &str) -> TextInputTracker {
        let mock_element_impl = MockUIElementImpl {
            text: text.to_string(),
            name: "mock_field".to_string(),
            role: "Edit".to_string(),
        };
        let ui_element = UIElement::new(Box::new(mock_element_impl));
        let mut tracker = TextInputTracker::new(ui_element);
        // Simulate some activity so the event can be emitted.
        tracker.has_typing_activity = true;
        tracker.keystroke_count = 1;
        tracker
    }

    #[test]
    fn test_get_completion_event_with_empty_text() {
        let tracker = create_tracker_with_text("");
        let event = tracker.get_completion_event(None);
        assert!(
            event.is_none(),
            "Event should not be generated for empty text"
        );
    }

    #[test]
    fn test_get_completion_event_with_whitespace_text() {
        let tracker = create_tracker_with_text("   \t\n  ");
        let event = tracker.get_completion_event(None);
        assert!(
            event.is_none(),
            "Event should not be generated for whitespace-only text"
        );
    }

    #[test]
    fn test_get_completion_event_with_valid_text() {
        let tracker = create_tracker_with_text("Hello, world!");
        let event = tracker.get_completion_event(None);
        assert!(event.is_some(), "Event should be generated for valid text");
        if let Some(e) = event {
            assert_eq!(e.text_value, "Hello, world!");
        }
    }
}
