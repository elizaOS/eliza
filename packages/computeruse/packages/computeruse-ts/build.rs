extern crate napi_build;

fn main() {
    // Statically link VC runtime to avoid VCRUNTIME140.dll dependency
    // This ensures the native module works on fresh Windows installs and Windows Sandbox
    #[cfg(target_os = "windows")]
    static_vcruntime::metabuild();

    napi_build::setup();
}
