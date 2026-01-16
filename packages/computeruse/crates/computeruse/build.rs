// use std::env;
// use std::process::Command;

fn main() {

    //     // disabled for some reason block forever on my windows
    //     // Only build bindings in release mode or when explicitly requested
    //     let profile = env::var("PROFILE").unwrap_or_default();
    //     let build_bindings = env::var("COMPUTERUSE_BUILD_BINDINGS").is_ok() || profile == "release";

    //     if !build_bindings {
    //         println!(
    //             "cargo:warning=Skipping bindings build (set COMPUTERUSE_BUILD_BINDINGS=1 to force)"
    //         );
    //         return;
    //     }

    //     println!("cargo:warning=Building Python and Node.js bindings...");

    //     // Build Python bindings
    //     if let Err(e) = build_python_bindings() {
    //         println!("cargo:warning=Failed to build Python bindings: {}", e);
    //     }

    //     // Build Node.js bindings
    //     if let Err(e) = build_nodejs_bindings() {
    //         println!("cargo:warning=Failed to build Node.js bindings: {}", e);
    //     }
    // }

    // fn build_python_bindings() -> Result<(), Box<dyn std::error::Error>> {
    //     let output = Command::new("python")
    //         .args(["-m", "maturin", "build", "--release"])
    //         .current_dir("../bindings/python")
    //         .output()?;

    //     if !output.status.success() {
    //         return Err(format!(
    //             "maturin failed: {}",
    //             String::from_utf8_lossy(&output.stderr)
    //         )
    //         .into());
    //     }

    //     println!("cargo:warning=Python bindings built successfully");
    //     Ok(())
    // }

    // fn build_nodejs_bindings() -> Result<(), Box<dyn std::error::Error>> {
    //     // First try npm run build, fallback to npx napi build
    //     let output = Command::new("npm")
    //         .args(["run", "build"])
    //         .current_dir("../bindings/nodejs")
    //         .output();

    //     match output {
    //         Ok(output) if output.status.success() => {
    //             println!("cargo:warning=Node.js bindings built successfully");
    //             Ok(())
    //         }
    //         _ => {
    //             // Fallback to direct napi build
    //             let output = Command::new("npx")
    //                 .args(["napi", "build", "--platform", "--release", "--strip"])
    //                 .current_dir("../bindings/nodejs")
    //                 .output()?;

    //             if !output.status.success() {
    //                 return Err(format!(
    //                     "napi build failed: {}",
    //                     String::from_utf8_lossy(&output.stderr)
    //                 )
    //                 .into());
    //             }

    //             println!("cargo:warning=Node.js bindings built successfully");
    //             Ok(())
    //         }
    //     }
}
