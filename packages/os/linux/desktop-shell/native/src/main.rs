// Placeholder daemon. The real implementation would call
// `eliza_linux_desktop_bridge::ipc::run_event_loop()` after wiring up the
// NetworkManager, UPower, PipeWire, login1, and timedated bindings.
fn main() {
    eprintln!("eliza-linux-desktop-bridge: not implemented");
    std::process::exit(1);
}
