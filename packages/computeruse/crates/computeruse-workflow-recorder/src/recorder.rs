use crate::{RecordedWorkflow, Result, WorkflowEvent, WorkflowRecorderError};
use std::{
    collections::{HashSet, VecDeque},
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::broadcast;
use tokio_stream::Stream;
use tracing::info;

#[cfg(target_os = "windows")]
pub mod windows;

pub mod browser_context;

#[cfg(target_os = "windows")]
pub use self::windows::*;

/// Performance mode for the workflow recorder
#[derive(Debug, Clone, PartialEq, Default)]
pub enum PerformanceMode {
    /// Default behavior - captures all events with full detail
    #[default]
    Normal,
    /// Moderate optimizations - some filtering and reduced capture frequency
    Balanced,
    /// Aggressive optimizations for weak computers - minimal overhead
    LowEnergy,
}

impl PerformanceMode {
    /// Create a configuration optimized for low-end computers
    ///
    /// # Examples
    ///
    /// ```rust
    /// use computeruse_workflow_recorder::{WorkflowRecorderConfig, PerformanceMode};
    ///
    /// let mut config = WorkflowRecorderConfig::default();
    /// config.performance_mode = PerformanceMode::LowEnergy;
    ///
    /// // Or use the helper method for a complete low-energy setup
    /// let low_energy_config = PerformanceMode::low_energy_config();
    /// ```
    pub fn low_energy_config() -> WorkflowRecorderConfig {
        WorkflowRecorderConfig {
            performance_mode: PerformanceMode::LowEnergy,
            max_events_per_second: Some(5),       // Very conservative
            event_processing_delay_ms: Some(100), // 100ms delays
            filter_mouse_noise: true,
            filter_keyboard_noise: true,
            reduce_ui_element_capture: true,
            record_text_input_completion: false, // Disable high-overhead feature
            mouse_move_throttle_ms: 500,         // Very slow mouse tracking
            ..WorkflowRecorderConfig::default()
        }
    }

    /// Create a configuration with balanced performance optimizations
    ///
    /// # Examples
    ///
    /// ```rust
    /// use computeruse_workflow_recorder::PerformanceMode;
    ///
    /// let balanced_config = PerformanceMode::balanced_config();
    /// ```
    pub fn balanced_config() -> WorkflowRecorderConfig {
        WorkflowRecorderConfig {
            performance_mode: PerformanceMode::Balanced,
            filter_mouse_noise: true,    // Skip mouse moves/scrolls
            mouse_move_throttle_ms: 200, // Moderate mouse tracking
            ..WorkflowRecorderConfig::default()
        }
    }
}

/// Configuration for the workflow recorder
#[derive(Debug, Clone)]
pub struct WorkflowRecorderConfig {
    /// Whether to record mouse events
    pub record_mouse: bool,

    /// Whether to record keyboard events
    pub record_keyboard: bool,

    /// Whether to capture UI element information
    pub capture_ui_elements: bool,

    /// Whether to record clipboard operations
    pub record_clipboard: bool,

    /// Whether to record hotkey/shortcut events
    pub record_hotkeys: bool,

    pub record_text_input_completion: bool,

    /// Whether to record high-level application switch events
    pub record_application_switches: bool,

    /// Whether to record high-level browser tab navigation events  
    pub record_browser_tab_navigation: bool,

    /// Minimum time between application switches to consider them separate (milliseconds)
    pub app_switch_dwell_time_threshold_ms: u64,

    /// Timeout for browser URL/title detection after tab actions (milliseconds)
    pub browser_detection_timeout_ms: u64,

    /// Maximum clipboard content length to record (longer content will be truncated)
    pub max_clipboard_content_length: usize,

    /// Whether to track modifier key states accurately
    pub track_modifier_states: bool,

    /// Minimum time between mouse move events to reduce noise (milliseconds)
    pub mouse_move_throttle_ms: u64,

    /// Minimum drag distance to distinguish between click and drag (pixels)
    pub min_drag_distance: f64,

    /// Patterns to ignore for UI focus change events (case-insensitive)
    pub ignore_focus_patterns: HashSet<String>,

    /// Patterns to ignore for UI property change events (case-insensitive)
    pub ignore_property_patterns: HashSet<String>,

    /// Window titles to ignore for UI events (case-insensitive)
    pub ignore_window_titles: HashSet<String>,

    /// Application/process names to ignore for UI events (case-insensitive)
    pub ignore_applications: HashSet<String>,

    /// Whether to enable multithreading for COM initialization and event processing
    /// On Windows: Controls COINIT_MULTITHREADED vs COINIT_APARTMENTTHREADED
    /// On other platforms: Controls threading model for equivalent operations
    ///
    /// # Examples
    ///
    /// ```rust
    /// use computeruse_workflow_recorder::WorkflowRecorderConfig;
    ///
    /// let mut config = WorkflowRecorderConfig::default();
    /// config.enable_multithreading = true;  // Use multithreaded COM (MTA)
    /// config.enable_multithreading = false; // Use apartment threaded COM (STA) - default
    /// ```
    ///
    /// Note: Apartment threaded (STA) mode may provide better system responsiveness
    /// but multithreaded (MTA) mode may be required for some complex scenarios.
    pub enable_multithreading: bool,

    // Performance optimization options
    /// Performance mode controlling overall resource usage and event filtering
    pub performance_mode: PerformanceMode,

    /// Custom delay between event processing cycles (milliseconds)
    /// None uses the performance_mode default
    pub event_processing_delay_ms: Option<u64>,

    /// Rate limiting for events per second
    /// None uses the performance_mode default  
    pub max_events_per_second: Option<u32>,

    /// Skip mouse move and scroll events to reduce noise (keeps clicks)
    pub filter_mouse_noise: bool,

    /// Skip key-down events and non-printable keys to reduce noise
    pub filter_keyboard_noise: bool,

    /// Reduce expensive UI element capture operations
    pub reduce_ui_element_capture: bool,

    // Visual highlighting options
    /// Enable real-time visual highlighting during recording
    pub enable_highlighting: bool,

    /// Highlight color in BGR format (0xBBGGRR)
    /// Default: 0x0000FF (red)
    pub highlight_color: Option<u32>,

    /// Highlight duration in milliseconds
    /// Default: 500ms
    pub highlight_duration_ms: Option<u64>,

    /// Show event type labels (CLICK, TYPE, etc.) on highlights
    pub show_highlight_labels: bool,

    /// Maximum number of concurrent highlights to prevent thread explosion
    /// Older highlights are automatically closed when this limit is reached
    /// Default: 10
    pub highlight_max_concurrent: usize,
}

impl Default for WorkflowRecorderConfig {
    fn default() -> Self {
        Self {
            record_mouse: true,
            record_keyboard: true, // TODO not used
            capture_ui_elements: true,
            record_clipboard: true,
            record_hotkeys: true,
            record_text_input_completion: true,
            record_application_switches: true, // High-level semantic events, enabled by default
            record_browser_tab_navigation: true, // High-level semantic events, enabled by default
            app_switch_dwell_time_threshold_ms: 100, // 100ms minimum dwell time to record
            browser_detection_timeout_ms: 1000, // 1 second to detect URL/title changes
            max_clipboard_content_length: 10240, // 10KB max
            track_modifier_states: true,
            mouse_move_throttle_ms: 100, // PERFORMANCE: Increased from 50ms to 100ms (10 FPS max for mouse moves)
            min_drag_distance: 5.0,      // 5 pixels minimum for drag detection
            ignore_focus_patterns: HashSet::new(), // TEMPORARILY DISABLED FOR TESTING
            ignore_property_patterns: HashSet::new(), // TEMPORARILY DISABLED FOR TESTING
            ignore_window_titles: HashSet::new(), // TEMPORARILY DISABLED FOR TESTING - File Explorer will now be captured!
            ignore_applications: HashSet::new(),  // TEMPORARILY DISABLED FOR TESTING
            enable_multithreading: false, // Default to false for better system responsiveness
            performance_mode: PerformanceMode::Normal,
            event_processing_delay_ms: None,
            max_events_per_second: None,
            filter_mouse_noise: false,
            filter_keyboard_noise: false,
            reduce_ui_element_capture: false,
            // Highlighting defaults
            enable_highlighting: false,
            highlight_color: Some(0x0000FF),  // Red in BGR
            highlight_duration_ms: Some(500), // 500ms
            show_highlight_labels: true,
            highlight_max_concurrent: 10,
        }
    }
}

impl WorkflowRecorderConfig {
    /// Get the effective event processing delay based on performance mode
    pub fn effective_processing_delay_ms(&self) -> u64 {
        if let Some(delay) = self.event_processing_delay_ms {
            return delay;
        }

        match self.performance_mode {
            PerformanceMode::Normal => 0,
            PerformanceMode::Balanced => 25,
            PerformanceMode::LowEnergy => 50,
        }
    }

    /// Get the effective max events per second based on performance mode
    pub fn effective_max_events_per_second(&self) -> Option<u32> {
        if let Some(limit) = self.max_events_per_second {
            return Some(limit);
        }

        match self.performance_mode {
            PerformanceMode::Normal => None,
            PerformanceMode::Balanced => Some(20),
            PerformanceMode::LowEnergy => Some(10),
        }
    }

    /// Check if mouse noise filtering should be enabled
    pub fn should_filter_mouse_noise(&self) -> bool {
        self.filter_mouse_noise
            || matches!(
                self.performance_mode,
                PerformanceMode::Balanced | PerformanceMode::LowEnergy
            )
    }

    /// Check if keyboard noise filtering should be enabled  
    pub fn should_filter_keyboard_noise(&self) -> bool {
        self.filter_keyboard_noise || matches!(self.performance_mode, PerformanceMode::LowEnergy)
    }

    /// Check if UI element capture should be reduced
    pub fn should_reduce_ui_capture(&self) -> bool {
        self.reduce_ui_element_capture
            || matches!(
                self.performance_mode,
                PerformanceMode::Balanced | PerformanceMode::LowEnergy
            )
    }
}

/// The workflow recorder
pub struct WorkflowRecorder {
    /// The recorded workflow
    pub workflow: Arc<Mutex<RecordedWorkflow>>,

    /// The event sender
    event_tx: broadcast::Sender<WorkflowEvent>,

    /// The configuration
    config: WorkflowRecorderConfig,

    /// The platform-specific recorder
    #[cfg(target_os = "windows")]
    windows_recorder: Option<WindowsRecorder>,

    /// Active highlight handles (FIFO queue for cleanup)
    highlight_handles: Arc<tokio::sync::Mutex<VecDeque<computeruse::HighlightHandle>>>,

    /// Handle to the highlighting task
    highlight_task_handle: Option<tokio::task::JoinHandle<()>>,
}

impl WorkflowRecorder {
    /// Create a new workflow recorder
    pub fn new(name: String, config: WorkflowRecorderConfig) -> Self {
        let workflow = Arc::new(Mutex::new(RecordedWorkflow::new(name)));
        let (event_tx, _) = broadcast::channel(1000); // Buffer size increased to 1000 to handle slow UI captures (e.g. File Explorer 5s timeout)

        Self {
            workflow,
            event_tx,
            config,
            #[cfg(target_os = "windows")]
            windows_recorder: None,
            highlight_handles: Arc::new(tokio::sync::Mutex::new(VecDeque::new())),
            highlight_task_handle: None,
        }
    }

    /// Get a stream of events
    pub fn event_stream(&self) -> impl Stream<Item = WorkflowEvent> {
        let mut rx = self.event_tx.subscribe();
        let receiver_count = self.event_tx.receiver_count();
        tracing::info!(
            "📡 New event stream subscriber created (total capacity: 1000, active receivers: {})",
            receiver_count
        );
        Box::pin(async_stream::stream! {
            let mut received_count = 0;
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        received_count += 1;
                        if received_count % 10 == 0 {
                            tracing::debug!("📥 Event stream received {} events so far", received_count);
                        }
                        yield event
                    },
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        // Log but continue - don't terminate stream on lag
                        tracing::error!("⚠️ Event stream LAGGED! Skipped {} events (received so far: {})", skipped, received_count);
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        // Channel closed, end stream
                        tracing::info!("🔚 Event stream closed (received {} total events)", received_count);
                        break;
                    }
                }
            }
        })
    }

    /// Start recording
    pub async fn start(&mut self) -> Result<()> {
        info!("Starting workflow recording");

        #[cfg(target_os = "windows")]
        {
            let workflow = Arc::clone(&self.workflow);
            let event_tx = self.event_tx.clone();

            // Start the Windows recorder
            let windows_recorder = WindowsRecorder::new(self.config.clone(), event_tx).await?;
            self.windows_recorder = Some(windows_recorder);

            // Start the event processing task
            let event_rx = self.event_tx.subscribe();
            tokio::spawn(async move {
                Self::process_events(workflow, event_rx).await;
            });

            // Start highlighting task if enabled
            if self.config.enable_highlighting {
                use futures::StreamExt;

                let mut event_stream = self.event_stream();
                let config = self.config.clone();
                let handles = self.highlight_handles.clone();

                let task = tokio::spawn(async move {
                    // Enable recording mode to prevent scroll_into_view during highlights
                    // This prevents spurious keyboard events (down arrows) from being recorded
                    #[cfg(target_os = "windows")]
                    computeruse::set_recording_mode(true);

                    info!("Visual highlighting enabled during recording (recording mode: scroll disabled)");

                    while let Some(event) = event_stream.next().await {
                        // Only highlight semantic/high-level events to avoid double highlighting
                        // Low-level Mouse(Up/Down) events are still recorded but not highlighted
                        // BrowserClick events are also skipped since a regular Click is always emitted alongside them
                        let should_highlight = matches!(
                            event,
                            WorkflowEvent::Click(_)
                                | WorkflowEvent::TextInputCompleted(_)
                                | WorkflowEvent::ApplicationSwitch(_)
                                | WorkflowEvent::BrowserTabNavigation(_)
                                // BrowserClick excluded - a regular Click is always emitted for these
                                | WorkflowEvent::DragDrop(_)
                                | WorkflowEvent::Hotkey(_)
                                | WorkflowEvent::BrowserTextInput(_)
                                | WorkflowEvent::FileOpened(_)
                        );

                        if should_highlight {
                            // Get UI element from event
                            if let Some(ui_element) = event.ui_element() {
                                // Get event label
                                let label = if config.show_highlight_labels {
                                    Some(Self::get_event_label(&event))
                                } else {
                                    None
                                };

                                // Create highlight
                                if let Ok(handle) = ui_element.highlight(
                                    config.highlight_color,
                                    config.highlight_duration_ms.map(Duration::from_millis),
                                    label,
                                    None, // text_position
                                    None, // font_style
                                ) {
                                    // Enforce max concurrent limit
                                    let mut list = handles.lock().await;
                                    if list.len() >= config.highlight_max_concurrent {
                                        // Remove oldest (FIFO)
                                        if let Some(old) = list.pop_front() {
                                            old.close();
                                        }
                                    }
                                    list.push_back(handle);
                                }
                            }
                        }
                    }

                    // Disable recording mode when highlighting task ends
                    #[cfg(target_os = "windows")]
                    computeruse::set_recording_mode(false);

                    info!("Highlighting task ended (recording mode disabled)");
                });

                self.highlight_task_handle = Some(task);
            }

            Ok(())
        }

        #[cfg(not(target_os = "windows"))]
        {
            Err(WorkflowRecorderError::InitializationError(
                "Workflow recording is only supported on Windows".to_string(),
            ))
        }
    }

    /// Stop recording
    pub async fn stop(&mut self) -> Result<()> {
        info!("Stopping workflow recording");

        #[cfg(target_os = "windows")]
        {
            if let Some(windows_recorder) = self.windows_recorder.take() {
                // Stop the recorder (sets is_stopping flag and waits 100ms)
                windows_recorder.stop()?;

                // Additional delay to ensure all event processing is fully stopped
                // before we proceed with workflow processing
                tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
            }
        }

        // Stop highlighting task if running
        if let Some(task) = self.highlight_task_handle.take() {
            task.abort(); // Cancel the task immediately
            info!("Highlighting task aborted");
        }

        // Close all active highlights immediately
        {
            let mut list = self.highlight_handles.lock().await;
            let count = list.len();
            while let Some(handle) = list.pop_front() {
                handle.close();
            }
            if count > 0 {
                info!("Closed {} active highlight(s)", count);
            }
        }

        // Mark the workflow as finished
        if let Ok(mut workflow) = self.workflow.lock() {
            workflow.finish();
        }

        Ok(())
    }

    /// Save the recorded workflow to a file
    pub fn save<P: AsRef<Path>>(&self, path: P) -> Result<()> {
        info!("Saving workflow recording to {:?}", path.as_ref());

        let workflow = self.workflow.lock().map_err(|e| {
            WorkflowRecorderError::SaveError(format!("Failed to lock workflow: {e}"))
        })?;

        workflow.save_to_file(path).map_err(|e| {
            WorkflowRecorderError::SaveError(format!("Failed to save workflow: {e}"))
        })?;

        Ok(())
    }

    /// Process events from the event receiver
    async fn process_events(
        workflow: Arc<Mutex<RecordedWorkflow>>,
        mut event_rx: broadcast::Receiver<WorkflowEvent>,
    ) {
        while let Ok(event) = event_rx.recv().await {
            // Create a simple recorded event without MCP conversion
            let timestamp = event.timestamp().unwrap_or_else(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64
            });

            let recorded_event = crate::events::RecordedEvent {
                timestamp,
                event,
                metadata: None, // Metadata can be added later if needed
            };

            // Add the event to the workflow (keep lock scope minimal)
            if let Ok(mut workflow_guard) = workflow.lock() {
                workflow_guard.add_enhanced_event(recorded_event);
            }
        }
    }

    /// Get a human-readable label for a workflow event
    fn get_event_label(event: &WorkflowEvent) -> &'static str {
        match event {
            WorkflowEvent::Click(_) => "CLICK",
            WorkflowEvent::TextInputCompleted(_) => "TYPE",
            WorkflowEvent::Keyboard(e) => {
                // For keyboard events, we could show the key, but static str is simpler
                // The MCP agent shows dynamic labels like "KEY: A", but here we keep it simple
                let _ = e; // Suppress unused warning
                "KEY"
            }
            WorkflowEvent::DragDrop(_) => "DRAG",
            WorkflowEvent::ApplicationSwitch(_) => "SWITCH",
            WorkflowEvent::BrowserTabNavigation(_) => "TAB",
            WorkflowEvent::Mouse(e) => {
                // Differentiate right-click, middle-click
                match e.button {
                    crate::MouseButton::Right => "RCLICK",
                    crate::MouseButton::Middle => "MCLICK",
                    _ => "MOUSE",
                }
            }
            WorkflowEvent::Hotkey(_) => "HOTKEY",
            WorkflowEvent::Clipboard(_) => "CLIPBOARD",
            WorkflowEvent::TextSelection(_) => "SELECT",
            WorkflowEvent::FileOpened(_) => "FILE",
            _ => "EVENT",
        }
    }
}
