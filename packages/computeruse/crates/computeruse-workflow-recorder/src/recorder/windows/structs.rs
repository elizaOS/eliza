use crate::events::EventMetadata;
use rdev::Key;
use std::time::Instant;
use computeruse::UIElement;
use tracing::{error, info};

/// Represents an input event that requires UI Automation processing.
#[derive(Debug)]
pub enum UIAInputRequest {
    ButtonPress {
        button: crate::events::MouseButton,
        position: crate::events::Position,
    },
    ButtonRelease {
        button: crate::events::MouseButton,
        position: crate::events::Position,
    },
    KeyPressForCompletion {
        key_code: u32,
    },
    ActivationKeyPress {
        key_code: u32,
    },
}

/// Text input tracking state
#[derive(Debug, Clone)]
pub struct TextInputTracker {
    /// The UI element being tracked
    pub element: UIElement,
    /// When tracking started
    pub start_time: Instant,
    /// Number of typing keystrokes (excludes navigation keys)
    pub keystroke_count: u32,
    /// Whether we've detected any actual typing
    pub has_typing_activity: bool,
    /// Whether we're in the middle of autocomplete navigation (arrow keys active)
    pub in_autocomplete_navigation: bool,
    /// Last time we detected autocomplete navigation activity
    pub last_autocomplete_activity: Instant,
    /// Text value before autocomplete selection (for change detection)
    pub text_before_autocomplete: Option<String>,
    /// How this field received focus
    pub focus_method: crate::events::FieldFocusMethod,
    /// Initial text value when tracking started (to detect placeholder text)
    pub initial_text: Option<String>,
}

impl TextInputTracker {
    pub fn new(element: UIElement) -> Self {
        // Capture initial text to detect placeholder text later
        let initial_text = Self::get_element_text_value_safe(&element);
        Self {
            element,
            start_time: Instant::now(),
            keystroke_count: 0,
            has_typing_activity: false,
            in_autocomplete_navigation: false,
            last_autocomplete_activity: Instant::now(),
            text_before_autocomplete: None,
            focus_method: crate::events::FieldFocusMethod::Unknown,
            initial_text,
        }
    }

    pub fn add_keystroke(&mut self, key_code: u32) {
        // Check for autocomplete navigation keys (arrow keys, escape)
        if Self::is_autocomplete_navigation_key(key_code) {
            self.in_autocomplete_navigation = true;
            self.last_autocomplete_activity = Instant::now();
            info!(
                "🔽 Autocomplete navigation detected: key {} (Arrow/Escape)",
                key_code
            );

            // Capture current text value before potential autocomplete selection
            if self.text_before_autocomplete.is_none() {
                self.text_before_autocomplete = Self::get_element_text_value_safe(&self.element);
                info!(
                    "📝 Captured text before autocomplete: {:?}",
                    self.text_before_autocomplete
                );
            }
            return;
        }

        // Only count actual typing keys, not navigation/modifier keys
        if Self::is_typing_key(key_code) {
            self.keystroke_count += 1;
            self.has_typing_activity = true;
            // Reset autocomplete state on new typing
            self.in_autocomplete_navigation = false;
        }
    }

    fn is_autocomplete_navigation_key(key_code: u32) -> bool {
        matches!(
            key_code,
            0x26 |  // Up arrow
            0x28 |  // Down arrow
            0x25 |  // Left arrow (less common in autocomplete but possible)
            0x27 |  // Right arrow (less common in autocomplete but possible)
            0x1B // Escape (cancel autocomplete)
        )
    }

    fn is_typing_key(key_code: u32) -> bool {
        // Letters, numbers, space, punctuation - actual content input
        matches!(key_code,
            0x30..=0x39 |  // Numbers 0-9
            0x41..=0x5A |  // Letters A-Z
            0x20 |         // Space
            0x08 |         // Backspace
            0x2E |         // Delete
            // Common punctuation and symbols
            0xBA..=0xC0 |  // ;=,-./`
            0xDB..=0xDE    // [\]'
        )
    }

    pub fn handle_enter_key(&mut self) -> bool {
        // If we're in autocomplete navigation, Enter likely selects a suggestion
        if self.in_autocomplete_navigation {
            let time_since_nav = self.last_autocomplete_activity.elapsed();
            if time_since_nav < std::time::Duration::from_millis(5000) {
                // 5 second window
                info!("🔥 Enter pressed during autocomplete navigation - suggestion selection detected!");
                self.has_typing_activity = true;
                self.keystroke_count += 1; // Count as one interaction
                self.in_autocomplete_navigation = false; // Reset state
                return true; // Indicates this is a suggestion selection
            }
        }
        false
    }

    pub fn should_emit_completion(&self, reason: &str) -> bool {
        // For trigger keys (Enter/Tab), require both activity and keystrokes
        if reason == "trigger_key" || reason == "suggestion_enter" {
            return self.has_typing_activity && self.keystroke_count > 0;
        }

        // For focus changes, only emit if there was actual typing activity
        // This prevents false positives from focusing non-input elements
        if reason == "focus_change" {
            return self.has_typing_activity || self.keystroke_count > 0;
        }

        // For suggestion clicks, always emit (autocomplete selections are valid)
        if reason == "suggestion_click" {
            return true; // Always emit for suggestion clicks
        }

        // Default: require activity
        self.has_typing_activity && self.keystroke_count > 0
    }

    #[allow(dead_code)]
    fn text_changed(&self) -> bool {
        // Always return false to avoid accessing element properties
        // We'll rely on keystroke counting instead
        false
    }

    pub fn get_completion_event(
        &self,
        input_method: Option<crate::TextInputMethod>,
    ) -> Option<crate::TextInputCompletedEvent> {
        // Try to get actual text value from the element with retry mechanism
        // First attempt
        let text_value = match self.element.text(0) {
            Ok(actual_text) => actual_text,
            Err(e) => {
                error!("❌ First attempt to get text value failed: {}", e);
                // Retry after short delay (similar to mouse down retry logic)
                std::thread::sleep(std::time::Duration::from_millis(50));
                info!("🔄 Retrying text extraction...");
                match self.element.text(0) {
                    Ok(actual_text) => {
                        info!("✅ Second attempt succeeded!");
                        actual_text
                    }
                    Err(e2) => {
                        error!("❌ Second attempt also failed: {}", e2);
                        // Graceful fallback: still emit event with metadata about the interaction
                        if self.keystroke_count > 0 {
                            format!(
                                "[Text extraction failed - {} keystrokes]",
                                self.keystroke_count
                            )
                        } else {
                            String::from("[Text extraction failed]")
                        }
                    }
                }
            }
        };

        // Add minimum threshold: Only emit TextInputCompleted if there was actual typing activity
        // AND the text is not empty/whitespace-only
        // This prevents false positives from focus events on non-input elements
        if text_value.trim().is_empty() && !text_value.starts_with("[Text extraction failed") {
            // Skip emission for empty/whitespace-only text, even if there was typing activity
            info!("ℹ️ Skipping TextInputCompleted event: empty/whitespace-only text (keystroke_count: {}, has_typing_activity: {})", self.keystroke_count, self.has_typing_activity);
            return None;
        }

        // Check if text is unchanged from initial value (placeholder text)
        // Still emit the event but note it's unchanged (for focus tracking)
        if let Some(ref initial) = self.initial_text {
            if text_value == *initial && !self.has_typing_activity {
                info!(
                    "ℹ️ Text unchanged from initial value '{}' - emitting with unchanged text.",
                    initial
                );
                // Continue to emit event (don't return None)
            }
        }

        let typing_duration_ms = self.start_time.elapsed().as_millis() as u64;

        // Use safe fallbacks for element properties
        let field_name = self.element.name();
        let field_type = self.element.role();

        // Determine input method
        let final_input_method = input_method.unwrap_or(crate::TextInputMethod::Typed);

        Some(crate::TextInputCompletedEvent {
            text_value,
            field_name,
            field_type,
            input_method: final_input_method,
            focus_method: self.focus_method.clone(),
            typing_duration_ms,
            keystroke_count: self.keystroke_count,
            process_name: Self::get_process_name_from_element(&self.element),
            metadata: EventMetadata::with_ui_element_and_timestamp(Some(self.element.clone())),
        })
    }

    /// Get process name from a UI element's process ID
    /// Uses fast native Windows API instead of slow sysinfo
    fn get_process_name_from_element(element: &UIElement) -> Option<String> {
        // Use UIElement.process_name() which uses fast native API on Windows
        element.process_name().ok()
    }

    fn get_element_text_value_safe(element: &UIElement) -> Option<String> {
        match element.text(0) {
            Ok(text) => Some(text),
            Err(e) => {
                info!(
                    "Could not safely get element text for autocomplete tracking (this is okay): {}",
                    e
                );
                None
            }
        }
    }
}

/// Modifier key states
#[derive(Debug, Clone)]
pub struct ModifierStates {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub win: bool,
}

#[derive(Debug, Clone)]
pub struct HotkeyPattern {
    pub action: String,
    pub keys: Vec<u32>,
}

/// Tracks the current application state for switch detection
#[derive(Debug, Clone)]
pub struct ApplicationState {
    /// Window and application name (as reported by Windows UI Automation)
    pub name: String,
    /// Process executable name (e.g., "chrome.exe", "Notepad.exe")
    pub process_name: Option<String>,
    /// Process ID
    pub process_id: u32,
    /// When the application became active
    pub start_time: Instant,
}

/// Tracks pending Alt+Tab state for application switch attribution
#[derive(Debug, Clone)]
pub struct AltTabTracker {
    /// Whether Alt+Tab was recently pressed
    pub pending_alt_tab: bool,
    /// When the Alt+Tab was pressed
    pub alt_tab_time: Option<Instant>,
    /// Timeout for considering Alt+Tab as the cause of app switch (ms)
    pub timeout_ms: u64,
}

impl AltTabTracker {
    pub fn new() -> Self {
        Self {
            pending_alt_tab: false,
            alt_tab_time: None,
            timeout_ms: 2000, // 2 second timeout for Alt+Tab attribution
        }
    }

    /// Mark that Alt+Tab was just pressed
    pub fn mark_alt_tab_pressed(&mut self) {
        self.pending_alt_tab = true;
        self.alt_tab_time = Some(Instant::now());
    }

    /// Check if a recent Alt+Tab should be attributed to an app switch
    pub fn consume_pending_alt_tab(&mut self) -> bool {
        if !self.pending_alt_tab {
            return false;
        }

        if let Some(alt_tab_time) = self.alt_tab_time {
            let elapsed = Instant::now().duration_since(alt_tab_time);
            if elapsed.as_millis() <= self.timeout_ms as u128 {
                // Consume the pending Alt+Tab
                self.pending_alt_tab = false;
                self.alt_tab_time = None;
                return true;
            } else {
                // Expired, clear state
                self.pending_alt_tab = false;
                self.alt_tab_time = None;
            }
        }

        false
    }

    /// Clear any pending Alt+Tab state (e.g., on timeout)
    pub fn clear_pending(&mut self) {
        self.pending_alt_tab = false;
        self.alt_tab_time = None;
    }
}

impl Default for AltTabTracker {
    fn default() -> Self {
        Self::new()
    }
}

/// Tracks browser tab navigation state
#[derive(Debug, Clone)]
pub struct BrowserTabTracker {
    /// Current browser application
    pub current_browser: Option<String>,
    /// Current URL (best effort detection)
    pub current_url: Option<String>,
    /// Current page title
    pub current_title: Option<String>,
    /// Known browser process names
    pub known_browsers: Vec<String>,
    /// When the current page was last accessed
    pub last_navigation_time: Instant,
}

impl Default for BrowserTabTracker {
    fn default() -> Self {
        Self {
            current_browser: None,
            current_url: None,
            current_title: None,
            known_browsers: vec![
                // Executable names
                "chrome.exe".to_string(),
                "firefox.exe".to_string(),
                "msedge.exe".to_string(),
                "brave.exe".to_string(),
                "opera.exe".to_string(),
                "vivaldi.exe".to_string(),
                "iexplore.exe".to_string(),
                // Display names
                "google chrome".to_string(),
                "chrome".to_string(),
                "firefox".to_string(),
                "mozilla firefox".to_string(),
                "microsoft edge".to_string(),
                "edge".to_string(),
                "brave".to_string(),
                "opera".to_string(),
                "vivaldi".to_string(),
                "internet explorer".to_string(),
            ],
            last_navigation_time: Instant::now(),
        }
    }
}

/// Double click tracking state
#[derive(Debug, Clone)]
pub struct DoubleClickTracker {
    /// Last click position
    pub last_click_position: Option<crate::events::Position>,
    /// Last click time
    pub last_click_time: Option<Instant>,
    /// Last clicked button
    pub last_click_button: Option<crate::events::MouseButton>,
    /// Maximum time between clicks to be considered a double click (in milliseconds)
    pub double_click_threshold_ms: u64,
    /// Maximum distance between clicks to be considered a double click (in pixels)
    pub double_click_distance_threshold: i32,
}

impl Default for DoubleClickTracker {
    fn default() -> Self {
        Self {
            last_click_position: None,
            last_click_time: None,
            last_click_button: None,
            double_click_threshold_ms: 500, // Standard Windows double-click time
            double_click_distance_threshold: 5, // 5 pixels tolerance
        }
    }
}

impl DoubleClickTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Check if a new click should be considered a double click
    pub fn is_double_click(
        &mut self,
        button: crate::events::MouseButton,
        position: crate::events::Position,
        current_time: Instant,
    ) -> bool {
        let is_double = if let (Some(last_pos), Some(last_time), Some(last_button)) = (
            &self.last_click_position,
            &self.last_click_time,
            &self.last_click_button,
        ) {
            // Check if same button
            *last_button == button &&
            // Check if within time threshold
            current_time.duration_since(*last_time).as_millis() <= self.double_click_threshold_ms as u128 &&
            // Check if within distance threshold
            {
                let distance = ((position.x - last_pos.x).pow(2) + (position.y - last_pos.y).pow(2)) as f64;
                distance.sqrt() <= self.double_click_distance_threshold as f64
            }
        } else {
            false
        };

        if is_double {
            // Reset tracking state after double click is detected
            // This prevents triple clicks from being detected as multiple double clicks
            self.reset();
        } else {
            // Update tracking state only if it's not a double click
            self.last_click_position = Some(position);
            self.last_click_time = Some(current_time);
            self.last_click_button = Some(button);
        }

        is_double
    }

    /// Reset the tracker (e.g., when a different type of input occurs)
    pub fn reset(&mut self) {
        self.last_click_position = None;
        self.last_click_time = None;
        self.last_click_button = None;
    }
}

/// Convert a Key to a u32
pub fn key_to_u32(key: &Key) -> u32 {
    match key {
        Key::KeyA => 0x41,
        Key::KeyB => 0x42,
        Key::KeyC => 0x43,
        Key::KeyD => 0x44,
        Key::KeyE => 0x45,
        Key::KeyF => 0x46,
        Key::KeyG => 0x47,
        Key::KeyH => 0x48,
        Key::KeyI => 0x49,
        Key::KeyJ => 0x4A,
        Key::KeyK => 0x4B,
        Key::KeyL => 0x4C,
        Key::KeyM => 0x4D,
        Key::KeyN => 0x4E,
        Key::KeyO => 0x4F,
        Key::KeyP => 0x50,
        Key::KeyQ => 0x51,
        Key::KeyR => 0x52,
        Key::KeyS => 0x53,
        Key::KeyT => 0x54,
        Key::KeyU => 0x55,
        Key::KeyV => 0x56,
        Key::KeyW => 0x57,
        Key::KeyX => 0x58,
        Key::KeyY => 0x59,
        Key::KeyZ => 0x5A,
        Key::Num0 => 0x30,
        Key::Num1 => 0x31,
        Key::Num2 => 0x32,
        Key::Num3 => 0x33,
        Key::Num4 => 0x34,
        Key::Num5 => 0x35,
        Key::Num6 => 0x36,
        Key::Num7 => 0x37,
        Key::Num8 => 0x38,
        Key::Num9 => 0x39,
        Key::Escape => 0x1B,
        Key::Backspace => 0x08,
        Key::Tab => 0x09,
        Key::Return => 0x0D,
        Key::Space => 0x20,
        Key::LeftArrow => 0x25,
        Key::UpArrow => 0x26,
        Key::RightArrow => 0x27,
        Key::DownArrow => 0x28,
        Key::Delete => 0x2E,
        Key::Home => 0x24,
        Key::End => 0x23,
        Key::PageUp => 0x21,
        Key::PageDown => 0x22,
        Key::F1 => 0x70,
        Key::F2 => 0x71,
        Key::F3 => 0x72,
        Key::F4 => 0x73,
        Key::F5 => 0x74,
        Key::F6 => 0x75,
        Key::F7 => 0x76,
        Key::F8 => 0x77,
        Key::F9 => 0x78,
        Key::F10 => 0x79,
        Key::F11 => 0x7A,
        Key::F12 => 0x7B,
        Key::ShiftLeft => 0xA0,
        Key::ShiftRight => 0xA1,
        Key::ControlLeft => 0xA2,
        Key::ControlRight => 0xA3,
        Key::Alt => 0xA4,
        Key::AltGr => 0xA5,
        Key::MetaLeft => 0x5B,
        Key::MetaRight => 0x5C,
        _ => 0,
    }
}

/// Stores click events constructed on mouse down, to be emitted on mouse up.
/// This allows reliable element capture (on down when UI is stable) while emitting
/// Click event after action completes (on up), so modals don't block the click action.
#[derive(Debug, Clone)]
pub struct PendingClickCapture {
    /// The Click event to emit (always present for left clicks)
    pub click_event: Option<crate::events::ClickEvent>,
    /// The BrowserClick event to emit (only for browser clicks with DOM info)
    pub browser_click_event: Option<crate::events::BrowserClickEvent>,
    /// When the mouse down occurred (for staleness check)
    pub timestamp: Instant,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{MouseButton, Position};

    #[test]
    fn test_double_click_tracker_basic() {
        let mut tracker = DoubleClickTracker::new();
        let position = Position { x: 100, y: 100 };
        let button = MouseButton::Left;
        let time1 = std::time::Instant::now();

        // First click should not be a double click
        let is_double = tracker.is_double_click(button, position, time1);
        assert!(
            !is_double,
            "First click should not be detected as double click"
        );

        // Second click within threshold should be a double click
        let time2 = time1 + std::time::Duration::from_millis(200);
        let is_double = tracker.is_double_click(button, position, time2);
        assert!(
            is_double,
            "Second click within threshold should be double click"
        );
    }

    #[test]
    fn test_double_click_tracker_timeout() {
        let mut tracker = DoubleClickTracker::new();
        let position = Position { x: 100, y: 100 };
        let button = MouseButton::Left;
        let time1 = std::time::Instant::now();

        // First click
        let is_double = tracker.is_double_click(button, position, time1);
        assert!(!is_double);

        // Second click after timeout should not be a double click
        let time2 = time1 + std::time::Duration::from_millis(600); // Longer than 500ms threshold
        let is_double = tracker.is_double_click(button, position, time2);
        assert!(!is_double, "Click after timeout should not be double click");
    }

    #[test]
    fn test_double_click_tracker_distance() {
        let mut tracker = DoubleClickTracker::new();
        let position1 = Position { x: 100, y: 100 };
        let position2 = Position { x: 200, y: 200 }; // Far away
        let button = MouseButton::Left;
        let time1 = std::time::Instant::now();

        // First click
        let is_double = tracker.is_double_click(button, position1, time1);
        assert!(!is_double);

        // Second click at different position should not be a double click
        let time2 = time1 + std::time::Duration::from_millis(200);
        let is_double = tracker.is_double_click(button, position2, time2);
        assert!(
            !is_double,
            "Click at different position should not be double click"
        );
    }

    #[test]
    fn test_double_click_tracker_different_button() {
        let mut tracker = DoubleClickTracker::new();
        let position = Position { x: 100, y: 100 };
        let time1 = std::time::Instant::now();

        // First click with left button
        let is_double = tracker.is_double_click(MouseButton::Left, position, time1);
        assert!(!is_double);

        // Second click with right button should not be a double click
        let time2 = time1 + std::time::Duration::from_millis(200);
        let is_double = tracker.is_double_click(MouseButton::Right, position, time2);
        assert!(
            !is_double,
            "Click with different button should not be double click"
        );
    }

    #[test]
    fn test_double_click_tracker_reset() {
        let mut tracker = DoubleClickTracker::new();
        let position = Position { x: 100, y: 100 };
        let button = MouseButton::Left;
        let time1 = std::time::Instant::now();

        // First click
        tracker.is_double_click(button, position, time1);

        // Reset tracker
        tracker.reset();

        // Next click should not be a double click because tracker was reset
        let time2 = time1 + std::time::Duration::from_millis(200);
        let is_double = tracker.is_double_click(button, position, time2);
        assert!(!is_double, "Click after reset should not be double click");
    }
}
