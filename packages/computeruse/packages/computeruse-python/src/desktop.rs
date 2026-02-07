use crate::element::UIElement;
use crate::exceptions::automation_error_to_pyerr;
use crate::locator::Locator;
use crate::types::{CommandOutput, ScreenshotResult};
use ::computeruse_core::Desktop as ComputerUseDesktop;
use base64::Engine;
use pyo3::prelude::*;
use pyo3_async_runtimes::tokio as pyo3_tokio;
use pyo3_async_runtimes::TaskLocals;
use pyo3_stub_gen::derive::*;
use std::sync::Once;
use tokio::time::sleep as tokio_sleep;

/// Main entry point for desktop automation.
#[gen_stub_pyclass]
#[pyclass(name = "Desktop")]
pub struct Desktop {
    inner: ComputerUseDesktop,
}

#[gen_stub_pymethods]
#[pymethods]
impl Desktop {
    #[new]
    #[pyo3(signature = (use_background_apps=None, activate_app=None, log_level=None))]
    #[pyo3(text_signature = "(use_background_apps=False, activate_app=False, log_level=None)")]
    /// Create a new Desktop automation instance with configurable options.
    ///
    /// Args:
    ///     use_background_apps (bool, optional): Enable background apps support. Defaults to False.
    ///     activate_app (bool, optional): Enable app activation support. Defaults to False.
    ///     log_level (str, optional): Logging level (e.g., 'info', 'debug', 'warn', 'error').
    ///                                Falls back to RUST_LOG or COMPUTERUSE_LOG_LEVEL env vars, defaults to 'info'.
    ///
    /// Returns:
    ///     Desktop: A new Desktop automation instance.
    pub fn new(
        use_background_apps: Option<bool>,
        activate_app: Option<bool>,
        log_level: Option<String>,
    ) -> PyResult<Self> {
        static INIT: Once = Once::new();

        // Priority: explicit param > RUST_LOG env > COMPUTERUSE_LOG_LEVEL env > "info" default
        let log_level = log_level
            .or_else(|| std::env::var("RUST_LOG").ok())
            .or_else(|| std::env::var("COMPUTERUSE_LOG_LEVEL").ok())
            .unwrap_or_else(|| "info".to_string());

        INIT.call_once(|| {
            let _ = tracing_subscriber::fmt()
                .with_env_filter(log_level)
                .try_init();
        });
        let use_background_apps = use_background_apps.unwrap_or(false);
        let activate_app = activate_app.unwrap_or(false);
        let desktop = ComputerUseDesktop::new(use_background_apps, activate_app)
            .map_err(automation_error_to_pyerr)?;
        Ok(Desktop { inner: desktop })
    }

    #[pyo3(text_signature = "($self)")]
    /// Get the root UI element of the desktop.
    ///
    /// Returns:
    ///     UIElement: The root UI element.
    pub fn root(&self) -> PyResult<UIElement> {
        let root = self.inner.root();
        Ok(UIElement { inner: root })
    }

    #[pyo3(text_signature = "($self)")]
    /// Get a list of all running applications.
    ///
    /// Returns:
    ///     List[UIElement]: List of application UI elements.
    pub fn applications(&self) -> PyResult<Vec<UIElement>> {
        self.inner
            .applications()
            .map(|apps| apps.into_iter().map(|e| UIElement { inner: e }).collect())
            .map_err(automation_error_to_pyerr)
    }

    #[pyo3(text_signature = "($self, name)")]
    /// Get a running application by name.
    ///
    /// Args:
    ///     name (str): The name of the application to find.
    ///
    /// Returns:
    ///     UIElement: The application UI element.
    pub fn application(&self, name: &str) -> PyResult<UIElement> {
        self.inner
            .application(name)
            .map(|e| UIElement { inner: e })
            .map_err(automation_error_to_pyerr)
    }

    #[pyo3(name = "open_application", text_signature = "($self, name)")]
    /// Open an application by name.
    ///
    /// Args:
    ///     name (str): The name of the application to open.
    pub fn open_application(&self, name: &str) -> PyResult<UIElement> {
        self.inner
            .open_application(name)
            .map(|e| UIElement { inner: e })
            .map_err(automation_error_to_pyerr)
    }

    #[pyo3(name = "activate_application", text_signature = "($self, name)")]
    /// Activate an application by name.
    ///
    /// Args:
    ///     name (str): The name of the application to activate.
    pub fn activate_application(&self, name: &str) -> PyResult<()> {
        self.inner
            .activate_application(name)
            .map_err(automation_error_to_pyerr)
    }

    #[pyo3(name = "locator", text_signature = "($self, selector)")]
    /// Create a locator for finding UI elements.
    ///
    /// Args:
    ///     selector (str): The selector string to find elements.
    ///
    /// Returns:
    ///     Locator: A locator for finding elements.
    pub fn locator(&self, selector: &str) -> PyResult<Locator> {
        let locator = self.inner.locator(selector);
        Ok(Locator { inner: locator })
    }

    #[pyo3(name = "run_command", signature = (windows_command=None, unix_command=None))]
    #[pyo3(text_signature = "($self, windows_command, unix_command)")]
    /// (async) Run a shell command.
    ///
    /// Args:
    ///     windows_command (Optional[str]): Command to run on Windows.
    ///     unix_command (Optional[str]): Command to run on Unix.
    ///
    /// Returns:
    ///     CommandOutput: The command output.
    pub fn run_command<'py>(
        &self,
        py: Python<'py>,
        windows_command: Option<String>,
        unix_command: Option<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let desktop = self.inner.clone();
        pyo3_tokio::future_into_py_with_locals(py, TaskLocals::with_running_loop(py)?, async move {
            let result = desktop
                .run_command(windows_command.as_deref(), unix_command.as_deref())
                .await
                .map_err(automation_error_to_pyerr)?;
            let py_result = CommandOutput::from(result);
            Ok(py_result)
        })
    }

    #[pyo3(
        name = "run",
        text_signature = "($self, command, shell=None, working_directory=None)"
    )]
    /// (async) Execute a shell command using GitHub Actions-style syntax.
    ///
    /// Args:
    ///     command (str): The command to run (can be single or multi-line).
    ///     shell (Optional[str]): Optional shell to use (defaults to PowerShell on Windows, bash on Unix).
    ///     working_directory (Optional[str]): Optional working directory for the command.
    ///
    /// Returns:
    ///     CommandOutput: The command output.
    pub fn run<'py>(
        &self,
        py: Python<'py>,
        command: String,
        shell: Option<String>,
        working_directory: Option<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let desktop = self.inner.clone();
        pyo3_tokio::future_into_py_with_locals(py, TaskLocals::with_running_loop(py)?, async move {
            let result = desktop
                .run(
                    command.as_str(),
                    shell.as_deref(),
                    working_directory.as_deref(),
                )
                .await
                .map_err(automation_error_to_pyerr)?;
            let py_result = CommandOutput::from(result);
            Ok(py_result)
        })
    }

    #[pyo3(name = "ocr_image_path", text_signature = "($self, image_path)")]
    /// (async) Perform OCR on an image file.
    ///
    /// Args:
    ///     image_path (str): Path to the image file.
    ///
    /// Returns:
    ///     str: The extracted text.
    pub fn ocr_image_path<'py>(
        &self,
        py: Python<'py>,
        image_path: &str,
    ) -> PyResult<Bound<'py, PyAny>> {
        let desktop = self.inner.clone();
        let image_path = image_path.to_string();
        pyo3_tokio::future_into_py_with_locals(py, TaskLocals::with_running_loop(py)?, async move {
            let result = desktop
                .ocr_image_path(&image_path)
                .await
                .map_err(automation_error_to_pyerr)?;
            Ok(result)
        })
    }

    #[pyo3(name = "ocr_screenshot", text_signature = "($self, screenshot)")]
    /// (async) Perform OCR on a screenshot.
    ///
    /// Args:
    ///     screenshot (ScreenshotResult): The screenshot to process.
    ///
    /// Returns:
    ///     str: The extracted text.
    pub fn ocr_screenshot<'py>(
        &self,
        py: Python<'py>,
        screenshot: &ScreenshotResult,
    ) -> PyResult<Bound<'py, PyAny>> {
        let desktop = self.inner.clone();
        let core_screenshot = ::computeruse_core::ScreenshotResult {
            image_data: screenshot.image_data.clone(),
            width: screenshot.width,
            height: screenshot.height,
            monitor: screenshot
                .monitor
                .as_ref()
                .map(|m| ::computeruse_core::Monitor {
                    id: m.id.clone(),
                    name: m.name.clone(),
                    is_primary: m.is_primary,
                    width: m.width,
                    height: m.height,
                    x: m.x,
                    y: m.y,
                    scale_factor: m.scale_factor,
                    work_area: None,
                }),
        };
        pyo3_tokio::future_into_py_with_locals(py, TaskLocals::with_running_loop(py)?, async move {
            let result = desktop
                .ocr_screenshot(&core_screenshot)
                .await
                .map_err(automation_error_to_pyerr)?;
            Ok(result)
        })
    }

    #[pyo3(name = "get_current_browser_window")]
    /// (async) Get the currently focused browser window.
    ///
    /// Returns:
    ///     UIElement: The current browser window element.
    pub fn get_current_browser_window<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let desktop = self.inner.clone();
        pyo3_tokio::future_into_py_with_locals(py, TaskLocals::with_running_loop(py)?, async move {
            let result = desktop
                .get_current_browser_window()
                .await
                .map_err(automation_error_to_pyerr)?;
            let py_result = UIElement { inner: result };
            Ok(py_result)
        })
    }

    #[pyo3(name = "get_current_window", text_signature = "($self)")]
    /// (async) Get the currently focused window.
    ///
    /// Returns:
    ///     UIElement: The current window element.
    pub fn get_current_window<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let desktop = self.inner.clone();
        pyo3_tokio::future_into_py_with_locals(py, TaskLocals::with_running_loop(py)?, async move {
            let result = desktop
                .get_current_window()
                .await
                .map_err(automation_error_to_pyerr)?;
            let py_result = UIElement { inner: result };
            Ok(py_result)
        })
    }

    #[pyo3(name = "get_current_application", text_signature = "($self)")]
    /// (async) Get the currently focused application.
    ///
    /// Returns:
    ///     UIElement: The current application element.
    pub fn get_current_application<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let desktop = self.inner.clone();
        pyo3_tokio::future_into_py_with_locals(py, TaskLocals::with_running_loop(py)?, async move {
            let result = desktop
                .get_current_application()
                .await
                .map_err(automation_error_to_pyerr)?;
            let py_result = UIElement { inner: result };
            Ok(py_result)
        })
    }

    #[pyo3(name = "open_url", signature = (url, browser=None))]
    #[pyo3(text_signature = "($self, url, browser)")]
    /// Open a URL in a browser.
    ///
    /// Args:
    ///     url (str): The URL to open.
    ///     browser (Optional[str]): The browser to use. Can be "Default", "Chrome", "Firefox", "Edge", "Brave", "Opera", "Vivaldi", or a custom browser path.
    pub fn open_url(&self, url: &str, browser: Option<&str>) -> PyResult<UIElement> {
        let browser_enum = browser.map(|b| match b.to_lowercase().as_str() {
            "default" => ::computeruse_core::Browser::Default,
            "chrome" => ::computeruse_core::Browser::Chrome,
            "firefox" => ::computeruse_core::Browser::Firefox,
            "edge" => ::computeruse_core::Browser::Edge,
            "brave" => ::computeruse_core::Browser::Brave,
            "opera" => ::computeruse_core::Browser::Opera,
            "vivaldi" => ::computeruse_core::Browser::Vivaldi,
            custom => ::computeruse_core::Browser::Custom(custom.to_string()),
        });
        self.inner
            .open_url(url, browser_enum)
            .map(|e| UIElement { inner: e })
            .map_err(automation_error_to_pyerr)
    }

    #[pyo3(name = "open_file", text_signature = "($self, file_path)")]
    /// Open a file with its default application.
    ///
    /// Args:
    ///     file_path (str): Path to the file to open.
    pub fn open_file(&self, file_path: &str) -> PyResult<()> {
        self.inner
            .open_file(file_path)
            .map_err(automation_error_to_pyerr)
    }

    #[pyo3(
        name = "activate_browser_window_by_title",
        text_signature = "($self, title)"
    )]
    /// Activate a browser window by title.
    ///
    /// Args:
    ///     title (str): The window title to match.
    pub fn activate_browser_window_by_title(&self, title: &str) -> PyResult<()> {
        self.inner
            .activate_browser_window_by_title(title)
            .map_err(automation_error_to_pyerr)
    }

    #[pyo3(name = "focused_element", text_signature = "($self)")]
    /// Get the currently focused element.
    ///
    /// Returns:
    ///     UIElement: The focused element.
    pub fn focused_element(&self) -> PyResult<UIElement> {
        self.inner
            .focused_element()
            .map(|e| UIElement { inner: e })
            .map_err(automation_error_to_pyerr)
    }

    #[pyo3(name = "get_window_tree", signature = (pid, title=None, config=None))]
    #[pyo3(text_signature = "($self, pid, title, config)")]
    /// Get the UI tree for a window identified by process ID and optional title.
    ///
    /// Args:
    ///     pid (int): Process ID of the target application.
    ///     title (Optional[str]): Optional window title filter.
    ///     config (Optional[TreeBuildConfig]): Optional configuration for tree building.
    ///
    /// Returns:
    ///     UINode: Complete UI tree starting from the identified window.
    pub fn get_window_tree(
        &self,
        pid: u32,
        title: Option<&str>,
        config: Option<crate::types::TreeBuildConfig>,
    ) -> PyResult<crate::types::UINode> {
        let rust_config = config.map(|c| c.into());
        self.inner
            .get_window_tree(pid, title, rust_config)
            .map(crate::types::UINode::from)
            .map_err(automation_error_to_pyerr)
    }

    // ============== NEW MONITOR METHODS ==============

    #[pyo3(name = "list_monitors", text_signature = "($self)")]
    /// (async) List all available monitors/displays.
    ///
    /// Returns:
    ///     List[Monitor]: List of monitor information.
    pub fn list_monitors<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let desktop = self.inner.clone();
        pyo3_tokio::future_into_py_with_locals(py, TaskLocals::with_running_loop(py)?, async move {
            let result = desktop
                .list_monitors()
                .await
                .map_err(automation_error_to_pyerr)?;
            let py_result: Vec<crate::types::Monitor> = result
                .into_iter()
                .map(crate::types::Monitor::from)
                .collect();
            Ok(py_result)
        })
    }

    #[pyo3(name = "get_primary_monitor", text_signature = "($self)")]
    /// (async) Get the primary monitor.
    ///
    /// Returns:
    ///     Monitor: Primary monitor information.
    pub fn get_primary_monitor<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let desktop = self.inner.clone();
        pyo3_tokio::future_into_py_with_locals(py, TaskLocals::with_running_loop(py)?, async move {
            let result = desktop
                .get_primary_monitor()
                .await
                .map_err(automation_error_to_pyerr)?;
            let py_result = crate::types::Monitor::from(result);
            Ok(py_result)
        })
    }

    #[pyo3(name = "get_active_monitor", text_signature = "($self)")]
    /// (async) Get the monitor containing the currently focused window.
    ///
    /// Returns:
    ///     Monitor: Active monitor information.
    pub fn get_active_monitor<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let desktop = self.inner.clone();
        pyo3_tokio::future_into_py_with_locals(py, TaskLocals::with_running_loop(py)?, async move {
            let result = desktop
                .get_active_monitor()
                .await
                .map_err(automation_error_to_pyerr)?;
            let py_result = crate::types::Monitor::from(result);
            Ok(py_result)
        })
    }

    #[pyo3(name = "get_monitor_by_id", text_signature = "($self, id)")]
    /// (async) Get a monitor by its ID.
    ///
    /// Args:
    ///     id (str): The monitor ID to find.
    ///
    /// Returns:
    ///     Monitor: Monitor information.
    pub fn get_monitor_by_id<'py>(&self, py: Python<'py>, id: &str) -> PyResult<Bound<'py, PyAny>> {
        let desktop = self.inner.clone();
        let id = id.to_string();
        pyo3_tokio::future_into_py_with_locals(py, TaskLocals::with_running_loop(py)?, async move {
            let result = desktop
                .get_monitor_by_id(&id)
                .await
                .map_err(automation_error_to_pyerr)?;
            let py_result = crate::types::Monitor::from(result);
            Ok(py_result)
        })
    }

    #[pyo3(name = "get_monitor_by_name", text_signature = "($self, name)")]
    /// (async) Get a monitor by its name.
    ///
    /// Args:
    ///     name (str): The monitor name to find.
    ///
    /// Returns:
    ///     Monitor: Monitor information.
    pub fn get_monitor_by_name<'py>(
        &self,
        py: Python<'py>,
        name: &str,
    ) -> PyResult<Bound<'py, PyAny>> {
        let desktop = self.inner.clone();
        let name = name.to_string();
        pyo3_tokio::future_into_py_with_locals(py, TaskLocals::with_running_loop(py)?, async move {
            let result = desktop
                .get_monitor_by_name(&name)
                .await
                .map_err(automation_error_to_pyerr)?;
            let py_result = crate::types::Monitor::from(result);
            Ok(py_result)
        })
    }

    #[pyo3(name = "capture_monitor", text_signature = "($self, monitor)")]
    /// (async) Capture a screenshot of a specific monitor.
    ///
    /// Args:
    ///     monitor (Monitor): The monitor to capture.
    ///
    /// Returns:
    ///     ScreenshotResult: The screenshot data.
    pub fn capture_monitor<'py>(
        &self,
        py: Python<'py>,
        monitor: &crate::types::Monitor,
    ) -> PyResult<Bound<'py, PyAny>> {
        let desktop = self.inner.clone();
        let rust_monitor = ::computeruse_core::Monitor {
            id: monitor.id.clone(),
            name: monitor.name.clone(),
            is_primary: monitor.is_primary,
            width: monitor.width,
            height: monitor.height,
            x: monitor.x,
            y: monitor.y,
            scale_factor: monitor.scale_factor,
            work_area: None,
        };
        pyo3_tokio::future_into_py_with_locals(py, TaskLocals::with_running_loop(py)?, async move {
            let result = desktop
                .capture_monitor(&rust_monitor)
                .await
                .map_err(automation_error_to_pyerr)?;
            let py_result = crate::types::ScreenshotResult::from(result);
            Ok(py_result)
        })
    }

    #[pyo3(name = "capture_all_monitors", text_signature = "($self)")]
    /// (async) Capture screenshots of all monitors.
    ///
    /// Returns:
    ///     List[Tuple[Monitor, ScreenshotResult]]: List of monitor and screenshot pairs.
    pub fn capture_all_monitors<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let desktop = self.inner.clone();
        pyo3_tokio::future_into_py_with_locals(py, TaskLocals::with_running_loop(py)?, async move {
            let result = desktop
                .capture_all_monitors()
                .await
                .map_err(automation_error_to_pyerr)?;
            let py_result: Vec<(crate::types::Monitor, crate::types::ScreenshotResult)> = result
                .into_iter()
                .map(|(monitor, screenshot)| {
                    (
                        crate::types::Monitor::from(monitor),
                        crate::types::ScreenshotResult::from(screenshot),
                    )
                })
                .collect();
            Ok(py_result)
        })
    }

    // ============== END MONITOR METHODS ==============

    // ============== ADDITIONAL MISSING METHODS ==============

    #[pyo3(name = "get_all_applications_tree", text_signature = "($self)")]
    /// (async) Get the UI tree for all open applications in parallel.
    ///
    /// Returns:
    ///     List[UINode]: List of UI trees for all applications.
    pub fn get_all_applications_tree<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let desktop = self.inner.clone();
        pyo3_tokio::future_into_py_with_locals(py, TaskLocals::with_running_loop(py)?, async move {
            let result = desktop
                .get_all_applications_tree()
                .await
                .map_err(automation_error_to_pyerr)?;
            let py_result: Vec<crate::types::UINode> =
                result.into_iter().map(crate::types::UINode::from).collect();
            Ok(py_result)
        })
    }

    #[pyo3(name = "windows_for_application", text_signature = "($self, name)")]
    /// (async) Get all window elements for a given application name.
    ///
    /// Args:
    ///     name (str): The name of the application whose windows will be retrieved.
    ///
    /// Returns:
    ///     List[UIElement]: A list of window elements belonging to the application.
    pub fn windows_for_application<'py>(
        &self,
        py: Python<'py>,
        name: &str,
    ) -> PyResult<Bound<'py, PyAny>> {
        let desktop = self.inner.clone();
        let name = name.to_string();
        pyo3_tokio::future_into_py_with_locals(py, TaskLocals::with_running_loop(py)?, async move {
            let result = desktop
                .windows_for_application(&name)
                .await
                .map_err(automation_error_to_pyerr)?;
            let py_result: Vec<UIElement> =
                result.into_iter().map(|e| UIElement { inner: e }).collect();
            Ok(py_result)
        })
    }

    #[pyo3(name = "press_key", text_signature = "($self, key)")]
    /// (async) Press a key globally.
    ///
    /// Args:
    ///     key (str): The key to press (e.g., "Enter", "Ctrl+C", "F1").
    pub fn press_key<'py>(&self, py: Python<'py>, key: &str) -> PyResult<Bound<'py, PyAny>> {
        let desktop = self.inner.clone();
        let key = key.to_string();
        pyo3_tokio::future_into_py_with_locals(py, TaskLocals::with_running_loop(py)?, async move {
            desktop
                .press_key(&key)
                .await
                .map_err(automation_error_to_pyerr)?;
            Ok(())
        })
    }

    #[pyo3(name = "set_zoom", text_signature = "($self, percentage)")]
    /// (async) Set the zoom level to a specific percentage.
    ///
    /// Args:
    ///     percentage (int): The zoom percentage (e.g., 100 for 100%, 150 for 150%, 50 for 50%).
    pub fn set_zoom<'py>(&self, py: Python<'py>, percentage: u32) -> PyResult<Bound<'py, PyAny>> {
        let desktop = self.inner.clone();
        pyo3_tokio::future_into_py_with_locals(py, TaskLocals::with_running_loop(py)?, async move {
            desktop
                .set_zoom(percentage)
                .await
                .map_err(automation_error_to_pyerr)?;
            Ok(())
        })
    }

    #[pyo3(name = "delay", text_signature = "($self, delay_ms)")]
    /// (async) Delay execution for a specified number of milliseconds.
    ///
    /// Args:
    ///     delay_ms (int): The delay in milliseconds.
    pub fn delay<'py>(&self, py: Python<'py>, delay_ms: u32) -> PyResult<Bound<'py, PyAny>> {
        pyo3_tokio::future_into_py_with_locals(py, TaskLocals::with_running_loop(py)?, async move {
            tokio_sleep(std::time::Duration::from_millis(delay_ms as u64)).await;
            Ok(())
        })
    }

    #[pyo3(name = "is_cancelled", text_signature = "($self)")]
    /// Check if execution has been cancelled.
    ///
    /// Returns:
    ///     bool: True if execution has been cancelled, False otherwise.
    pub fn is_cancelled(&self) -> bool {
        self.inner.is_cancelled()
    }

    #[pyo3(name = "stop_execution", text_signature = "($self)")]
    /// Stop/cancel the current execution.
    pub fn stop_execution(&self) {
        self.inner.stop_execution();
    }

    #[pyo3(name = "click_at_coordinates", text_signature = "($self, x, y, restore_cursor=False)")]
    /// Click at specific screen coordinates.
    ///
    /// Args:
    ///     x (float): X coordinate.
    ///     y (float): Y coordinate.
    ///     restore_cursor (bool): Whether to restore cursor position after clicking.
    pub fn click_at_coordinates(&self, x: f64, y: f64, restore_cursor: Option<bool>) -> PyResult<()> {
        self.inner
            .click_at_coordinates(x, y, restore_cursor.unwrap_or(false))
            .map_err(automation_error_to_pyerr)
    }

    #[pyo3(name = "capture_screenshot", text_signature = "($self, monitor_id=None)")]
    /// (async) Capture a screenshot of a monitor or the primary monitor.
    ///
    /// Args:
    ///     monitor_id (Optional[str]): The monitor ID to capture. If None, captures the primary monitor.
    ///
    /// Returns:
    ///     ScreenshotResult: The screenshot data.
    pub fn capture_screenshot<'py>(
        &self,
        py: Python<'py>,
        monitor_id: Option<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let desktop = self.inner.clone();
        pyo3_tokio::future_into_py_with_locals(py, TaskLocals::with_running_loop(py)?, async move {
            let result = if let Some(id) = monitor_id {
                let monitor = desktop.get_monitor_by_id(&id).await.map_err(automation_error_to_pyerr)?;
                desktop.capture_monitor(&monitor).await
            } else {
                let monitor = desktop.get_primary_monitor().await.map_err(automation_error_to_pyerr)?;
                desktop.capture_monitor(&monitor).await
            };
            result
                .map(ScreenshotResult::from)
                .map_err(automation_error_to_pyerr)
        })
    }

    #[pyo3(name = "screenshot_to_base64_png", text_signature = "($self, screenshot)")]
    /// Convert a screenshot to a base64-encoded PNG string.
    ///
    /// Args:
    ///     screenshot (ScreenshotResult): The screenshot to convert.
    ///
    /// Returns:
    ///     str: Base64-encoded PNG string.
    pub fn screenshot_to_base64_png(&self, screenshot: ScreenshotResult) -> PyResult<String> {
        let rust_screenshot: computeruse_core::ScreenshotResult = screenshot.into();
        let png_bytes = rust_screenshot
            .to_png()
            .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Failed to encode PNG: {e}")))?;
        Ok(base64::engine::general_purpose::STANDARD.encode(&png_bytes))
    }

    #[pyo3(name = "screenshot_to_png", text_signature = "($self, screenshot)")]
    /// Convert a screenshot to PNG bytes.
    ///
    /// Args:
    ///     screenshot (ScreenshotResult): The screenshot to convert.
    ///
    /// Returns:
    ///     bytes: PNG bytes.
    pub fn screenshot_to_png(&self, screenshot: ScreenshotResult) -> PyResult<Vec<u8>> {
        let rust_screenshot: computeruse_core::ScreenshotResult = screenshot.into();
        rust_screenshot
            .to_png()
            .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Failed to encode PNG: {e}")))
    }

    #[pyo3(name = "close_tab", text_signature = "($self, tab_index=None, browser_name=None, window_title=None)")]
    /// (async) Close the current browser tab (Ctrl+W / Cmd+W).
    ///
    /// Args:
    ///     tab_index (Optional[int]): The tab index to close.
    ///     browser_name (Optional[str]): The browser name.
    ///     window_title (Optional[str]): The window title.
    pub fn close_tab<'py>(
        &self,
        py: Python<'py>,
        tab_index: Option<i32>,
        browser_name: Option<String>,
        window_title: Option<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let desktop = self.inner.clone();
        pyo3_tokio::future_into_py_with_locals(py, TaskLocals::with_running_loop(py)?, async move {
            desktop
                .close_tab(tab_index, browser_name.as_deref(), window_title.as_deref())
                .await
                .map_err(automation_error_to_pyerr)?;
            Ok(())
        })
    }
}
