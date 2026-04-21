use std::process::Command;

const TIMEOUT_SECS: u64 = 30;

pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}

pub fn exec(command: &str) -> ShellResult {
    let mut child = {
        let res = if cfg!(windows) {
            Command::new("cmd")
                .args(["/C", command])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
        } else {
            Command::new("sh")
                .args(["-c", command])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
        };
        match res {
            Ok(c) => c,
            Err(e) => {
                return ShellResult {
                    stdout: String::new(),
                    stderr: e.to_string(),
                    success: false,
                }
            }
        }
    };

    let deadline =
        std::time::Instant::now() + std::time::Duration::from_secs(TIMEOUT_SECS);

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = read_pipe(child.stdout.take());
                let stderr = read_pipe(child.stderr.take());
                return ShellResult {
                    stdout,
                    stderr,
                    success: status.success(),
                };
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return ShellResult {
                        stdout: String::new(),
                        stderr: format!("command timed out after {}s", TIMEOUT_SECS),
                        success: false,
                    };
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => {
                return ShellResult {
                    stdout: String::new(),
                    stderr: e.to_string(),
                    success: false,
                }
            }
        }
    }
}

fn read_pipe(pipe: Option<impl std::io::Read>) -> String {
    match pipe {
        Some(mut r) => {
            let mut buf = String::new();
            let _ = std::io::Read::read_to_string(&mut r, &mut buf);
            if buf.len() > 65536 {
                buf.truncate(65536);
                buf.push_str("...[truncated]");
            }
            buf
        }
        None => String::new(),
    }
}
