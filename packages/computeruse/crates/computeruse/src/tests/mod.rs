mod boolean_selector_tests;
#[cfg(test)]
mod close_tab_tests;
mod e2e_tests;
mod firefox_window_tests;
mod functional_verification_tests;
#[cfg(target_os = "windows")]
mod get_applications_tests;
#[cfg(test)]
mod high_level_inputs_tests;
#[cfg(all(test, target_os = "windows"))]
mod id_stability_tests;
mod notepad_selector_test;
#[cfg(test)]
mod parent_navigation_tests;
#[cfg(test)]
mod performance_tests;
#[cfg(all(test, target_os = "windows"))]
mod selector_tests;
mod test_serialization;

// Initialize tracing for tests
pub fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};
    fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive(tracing::Level::DEBUG.into()))
        .with_target(true)
        .with_thread_ids(false)
        .with_file(true)
        .with_line_number(true)
        .init();
}
