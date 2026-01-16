//! Cargo subcommand wrapper for the computeruse CLI
//!
//! This allows using `cargo computeruse <command>` instead of `cargo run --bin computeruse -- <command>`

use std::env;
use std::process::Command;

fn main() {
    let args: Vec<String> = env::args().collect();

    // Skip the first argument (cargo-computeruse) and pass the rest to the main computeruse CLI
    let mut cmd = Command::new("cargo");
    cmd.arg("run").arg("--bin").arg("computeruse").arg("--");

    // When called as "cargo computeruse", cargo passes:
    // ["cargo-computeruse", "computeruse", <actual_args>...]
    // So we need to skip the first 2 arguments
    let args_to_pass = if args.len() > 1 && args[1] == "computeruse" {
        &args[2..] // Skip "cargo-computeruse" and "computeruse"
    } else {
        &args[1..] // Skip just "cargo-computeruse"
    };

    for arg in args_to_pass {
        cmd.arg(arg);
    }

    let status = cmd
        .status()
        .expect("Failed to execute cargo run --bin computeruse");
    std::process::exit(status.code().unwrap_or(1));
}
