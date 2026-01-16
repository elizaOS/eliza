use pyo3_stub_gen::Result;
use std::fs;
use std::path::Path;
use tracing::{debug, error, info};

fn extract_return_type_from_docstring(docstring_lines: &[&str]) -> Option<String> {
    for (i, line) in docstring_lines.iter().enumerate() {
        if line.contains("Returns:") && i + 1 < docstring_lines.len() {
            let next_line = docstring_lines[i + 1];
            if let Some(type_part) = next_line.split(':').next() {
                return Some(type_part.trim().to_string());
            }
        }
    }
    None
}

fn get_docstring_lines<'a>(lines: &'a [&'a str], start_idx: usize) -> (Vec<&'a str>, usize) {
    let mut docstring_lines = Vec::new();
    let mut i = start_idx;

    if i < lines.len() && lines[i].trim().starts_with("r\"\"\"") {
        docstring_lines.push(lines[i]);
        i += 1;

        while i < lines.len() && !lines[i].trim().ends_with("\"\"\"") {
            docstring_lines.push(lines[i]);
            i += 1;
        }

        if i < lines.len() {
            docstring_lines.push(lines[i]);
            i += 1;
        }
    }

    (docstring_lines, i)
}

fn fix_type_annotation(type_str: &str) -> String {
    // First check if the type already has typing. prefix
    if type_str.contains("typing.List[") || type_str.contains("typing.Optional[") {
        return type_str.to_string();
    }

    // Replace List[ with typing.List[
    let mut result = type_str.replace("List[", "typing.List[");
    // Replace Optional[ with typing.Optional[
    result = result.replace("Optional[", "typing.Optional[");

    result
}

fn fix_async_functions(file_path: &Path) -> Result<()> {
    debug!("Reading file: {}", file_path.display());
    let content = fs::read_to_string(file_path)?;
    let lines: Vec<&str> = content.lines().collect();
    let mut new_lines = Vec::new();
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i];

        if line.trim().starts_with("def ") || line.trim().starts_with("async def ") {
            let (docstring_lines, _) = get_docstring_lines(&lines, i + 1);

            let is_async = docstring_lines.iter().any(|line| line.contains("(async)"));

            if is_async {
                debug!("Found async function at line {}", i + 1);
                let mut new_line = line.to_string();

                if !line.trim().starts_with("async def ") {
                    debug!("Adding async keyword to function definition");
                    new_line = line.replace("def ", "async def ");
                }

                if let Some(return_type) = extract_return_type_from_docstring(&docstring_lines) {
                    debug!("Found return type: {}", return_type);

                    if new_line.contains("->") {
                        let parts: Vec<&str> = new_line.split("->").collect();
                        let current_return = parts[1].split('#').next().unwrap().trim();

                        let new_return_type = if current_return == "None" {
                            "None".to_string()
                        } else {
                            fix_type_annotation(&return_type)
                        };

                        debug!(
                            "Updating return type from {} to {}",
                            current_return, new_return_type
                        );
                        new_line = new_line.replace(
                            &format!("-> {current_return}"),
                            &format!("-> {new_return_type}"),
                        );
                    } else {
                        let new_return_type = if return_type == "None" {
                            "None".to_string()
                        } else {
                            fix_type_annotation(&return_type)
                        };

                        debug!("Adding return type: {}", new_return_type);
                        new_line = new_line.trim_end_matches(':').to_string()
                            + &format!(" -> {new_return_type}:");
                    }
                }

                if !new_line.trim_end().ends_with(':') {
                    debug!("Adding missing colon to function definition");
                    new_line = new_line.trim_end().to_string() + ":";
                }

                new_lines.push(new_line);
            } else {
                new_lines.push(line.to_string());
            }
        } else {
            new_lines.push(line.to_string());
        }

        i += 1;
    }

    debug!("Writing updated content back to file");
    fs::write(file_path, new_lines.join("\n"))?;
    Ok(())
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    info!("Starting stub generation");
    let stub = computeruse::stub_info()?;
    stub.generate()?;
    info!("Stub generation completed");

    // Get the path to the stub file that was just generated
    let stub_path = Path::new("computeruse.pyi");
    info!("Fixing async functions in {}", stub_path.display());
    if let Err(e) = fix_async_functions(stub_path) {
        error!("Failed to fix async functions: {}", e);
        return Err(e);
    }
    info!("Successfully fixed async functions");

    Ok(())
}
