use crate::art_format::{group_trajectories, to_art_trajectory};
use crate::types::{Trajectory, TrajectoryGroup};
use std::fs;
use std::path::Path;

/// Write trajectories as ART JSONL to a file.
pub fn export_for_openpipe_art<P: AsRef<Path>>(
    dataset_name: &str,
    trajectories: &[Trajectory],
    out_path: Option<P>,
) -> std::io::Result<String> {
    let path = match out_path {
        Some(p) => p.as_ref().to_path_buf(),
        None => {
            let safe = dataset_name
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect::<String>();
            std::env::current_dir()?.join(format!("{}.trajectories.art.jsonl", safe))
        }
    };

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut lines = String::new();
    for t in trajectories {
        let art = to_art_trajectory(t);
        lines.push_str(&serde_json::to_string(&art).unwrap_or_else(|_| "{}".to_string()));
        lines.push('\n');
    }

    fs::write(&path, lines)?;
    Ok(path.to_string_lossy().to_string())
}

/// Write GRPO groups (JSON) to a file.
pub fn export_grouped_for_grpo<P: AsRef<Path>>(
    dataset_name: &str,
    trajectories: &[Trajectory],
    now_ms: i64,
    out_path: Option<P>,
) -> std::io::Result<String> {
    let path = match out_path {
        Some(p) => p.as_ref().to_path_buf(),
        None => {
            let safe = dataset_name
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect::<String>();
            std::env::current_dir()?.join(format!("{}.trajectories.grpo.groups.json", safe))
        }
    };

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let groups: Vec<TrajectoryGroup> = group_trajectories(trajectories, now_ms);
    let json = serde_json::to_string_pretty(&groups).unwrap_or_else(|_| "[]".to_string());
    fs::write(&path, format!("{}\n", json))?;
    Ok(path.to_string_lossy().to_string())
}
