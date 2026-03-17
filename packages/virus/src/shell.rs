use std::process::Command;

pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}

pub fn exec(command: &str) -> ShellResult {
    let output = if cfg!(windows) {
        Command::new("cmd").args(["/C", command]).output()
    } else {
        Command::new("sh").args(["-c", command]).output()
    };

    match output {
        Ok(out) => ShellResult {
            stdout: String::from_utf8_lossy(&out.stdout).to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
            success: out.status.success(),
        },
        Err(e) => ShellResult {
            stdout: String::new(),
            stderr: e.to_string(),
            success: false,
        },
    }
}
