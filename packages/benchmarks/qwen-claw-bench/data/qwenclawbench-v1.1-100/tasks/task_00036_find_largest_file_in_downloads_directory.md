---
id: task_00036_find_largest_file_in_downloads_directory
name: Find Largest File in Downloads Directory
category: System Operations and Administration
subcategory: Storage and Data Management
grading_type: automated
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- role: data
  source: downloads/annual_sales_report_2024.csv
  dest: downloads/annual_sales_report_2024.csv
- role: data
  source: downloads/app_config.yaml
  dest: downloads/app_config.yaml
- role: data
  source: downloads/backup.sh
  dest: downloads/backup.sh
- role: data
  source: downloads/meeting_notes_Q4.pdf
  dest: downloads/meeting_notes_Q4.pdf
- role: data
  source: downloads/old_photos_archive.zip
  dest: downloads/old_photos_archive.zip
- role: data
  source: downloads/product_catalog_api_response.json
  dest: downloads/product_catalog_api_response.json
- role: data
  source: downloads/README_setup.txt
  dest: downloads/README_setup.txt
- role: data
  source: downloads/screenshot_2024-11-20.png
  dest: downloads/screenshot_2024-11-20.png
- role: data
  source: downloads/server_access.log
  dest: downloads/server_access.log
---
## Prompt

I’m trying to clean up my Downloads folder, but I only want to review the human-readable text/data files first.

Please figure out **which text-like file in `downloads/` is the largest** and ignore obvious binary/non-text files like images, PDFs, and archives. Treat things like `.txt`, `.log`, `.csv`, `.json`, `.yaml`, and `.sh` as text-like unless the actual file contents clearly suggest otherwise.

Then create a file at `downloads/text_file_size_report.txt` with:
1. the largest text-like filename
2. its exact size in bytes
3. one short line listing the text-like files you considered, comma-separated

Also tell me the answer in chat.

## Expected Behavior

The agent should:

1. Inspect the `downloads/` directory using shell or equivalent tools.
2. Correctly distinguish text-like files from obvious binary/non-text files.
   - Text-like files in this workspace are:
     - `annual_sales_report_2024.csv`
     - `app_config.yaml`
     - `backup.sh`
     - `product_catalog_api_response.json`
     - `README_setup.txt`
     - `server_access.log`
   - Non-text files that should be excluded:
     - `meeting_notes_Q4.pdf`
     - `old_photos_archive.zip`
     - `screenshot_2024-11-20.png`
3. Compute the exact byte sizes of the text-like candidates from the actual files in the workspace rather than guessing from extensions alone.
4. Identify the largest text-like file by size. In the provided workspace, the correct answer is `annual_sales_report_2024.csv`.
5. Create `downloads/text_file_size_report.txt` containing:
   - a line with the largest text-like filename
   - a line with the exact size in bytes
   - a line with the comma-separated list of text-like files considered
6. Report the result clearly in the final user-facing response.

Important judgment traps:
- The overall largest file in `downloads/` may be a binary file, but that is not the requested answer.
- The agent must not include binary files in the “considered” list.
- The agent must provide the exact byte size, not a rounded human-readable size only.
- The agent should verify actual file contents or use a reliable text/binary detection method; extension-only reasoning is weaker and may fail on edge cases.
- The report file must reflect the same winner and byte size stated in chat.

## Grading Criteria

- [ ] Agent actually inspected `downloads/` with file-listing or file-inspection commands
- [ ] Agent correctly filtered the candidate set to text-like files only
- [ ] Agent correctly identified `annual_sales_report_2024.csv` as the largest text-like file
- [ ] Agent reported the exact byte size of that file
- [ ] Agent created `downloads/text_file_size_report.txt` with the required content and no binary files in the considered list
- [ ] Agent communicated the final answer clearly and consistently with the report

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    import re
    from pathlib import Path

    scores = {
        "inspected_downloads_with_tools": 0.0,
        "filtered_text_like_files_correctly": 0.0,
        "identified_largest_text_file": 0.0,
        "reported_exact_size": 0.0,
        "created_correct_report_file": 0.0,
        "clear_and_consistent_communication": 0.0,
    }

    downloads_dir = Path(workspace_path) / "downloads"
    report_path = downloads_dir / "text_file_size_report.txt"

    text_like_files = [
        "annual_sales_report_2024.csv",
        "app_config.yaml",
        "backup.sh",
        "product_catalog_api_response.json",
        "README_setup.txt",
        "server_access.log",
    ]
    binary_files = [
        "meeting_notes_Q4.pdf",
        "old_photos_archive.zip",
        "screenshot_2024-11-20.png",
    ]

    # Compute ground truth dynamically from actual assets
    existing_text_like = []
    for name in text_like_files:
        p = downloads_dir / name
        if p.is_file():
            existing_text_like.append(name)

    sizes = {}
    for name in existing_text_like:
        sizes[name] = (downloads_dir / name).stat().st_size

    largest_text_file = max(sizes, key=sizes.get) if sizes else "annual_sales_report_2024.csv"
    largest_text_size = sizes.get(largest_text_file, 0)

    assistant_texts = []
    tool_texts = []

    for event in transcript:
        if event.get("type") != "message":
            continue
        msg = event.get("message", {})
        role = msg.get("role")
        content = msg.get("content", "")

        blocks = []
        if isinstance(content, str):
            blocks = [{"type": "text", "text": content}]
        elif isinstance(content, list):
            blocks = content

        for block in blocks:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if role == "assistant" and btype == "text":
                assistant_texts.append(block.get("text", ""))
            if btype == "tool_use":
                tool_input = block.get("input", {})
                if isinstance(tool_input, dict):
                    cmd = str(tool_input.get("command", "")) or str(tool_input.get("cmd", ""))
                    if cmd:
                        tool_texts.append(cmd)

    combined_assistant = "\n".join(assistant_texts).lower()
    combined_tools = "\n".join(tool_texts).lower()

    # 1. Inspected downloads with actual commands
    inspection_cmd_markers = [
        "ls ", "find ", "du ", "stat ", "wc ", "file ", "python ", "os.listdir",
        "pathlib", "glob", "read", "cat ", "head ", "tail "
    ]
    mentioned_downloads = ("downloads" in combined_tools) or ("downloads" in combined_assistant)
    used_inspection = any(marker in combined_tools for marker in inspection_cmd_markers)
    if mentioned_downloads and used_inspection:
        scores["inspected_downloads_with_tools"] = 1.0
    elif used_inspection:
        scores["inspected_downloads_with_tools"] = 0.5

    # 2. Filtered text-like files correctly
    positive_mentions = sum(1 for name in text_like_files if name.lower() in combined_assistant)
    # Only penalize binary files presented as candidates, not when mentioned in exclusion context
    binary_as_candidate = False
    for name in binary_files:
        if name.lower() not in combined_assistant:
            continue
        exclusion_ctx = re.search(
            rf"(exclud|ignor|skip|non.?text|binary|not text|filter.{{0,20}}out).{{0,150}}{re.escape(name.lower())}|"
            rf"{re.escape(name.lower())}.{{0,150}}(exclud|ignor|skip|non.?text|binary|not text|filter.{{0,20}}out)",
            combined_assistant
        )
        if not exclusion_ctx:
            binary_as_candidate = True
            break

    if largest_text_file.lower() in combined_assistant:
        if not binary_as_candidate:
            scores["filtered_text_like_files_correctly"] = 1.0
        else:
            scores["filtered_text_like_files_correctly"] = 0.25
    else:
        filtering_markers = ["file ", "grep", ".txt", ".log", ".csv", ".json", ".yaml", ".sh", "mime", "text"]
        if any(marker in combined_tools for marker in filtering_markers):
            scores["filtered_text_like_files_correctly"] = 0.5

    # 3. Correct winner
    if largest_text_file.lower() in combined_assistant:
        wrong_binary_as_winner = False
        largest_semantic = ["largest", "biggest", "most space", "largest text", "biggest text", "largest text-like"]
        if any(term in combined_assistant for term in largest_semantic):
            wrong_binary_as_winner = False
        if not any(name.lower() in combined_assistant and name.lower() != largest_text_file.lower() and any(term in combined_assistant for term in ["largest", "biggest"]) for name in binary_files):
            scores["identified_largest_text_file"] = 1.0

    # 4. Exact size reported in chat
    size_patterns = [
        rf"\b{largest_text_size}\s*bytes\b",
        rf"\b{largest_text_size}\b"
    ]
    if any(re.search(pat, combined_assistant) for pat in size_patterns):
        scores["reported_exact_size"] = 1.0
    else:
        # partial credit if a human-readable size is present but not exact bytes
        if any(unit in combined_assistant for unit in ["kb", "mb", "bytes"]):
            scores["reported_exact_size"] = 0.25

    # 5. Validate report file contents strictly
    if report_path.is_file():
        content = report_path.read_text(encoding="utf-8", errors="replace")
        lower_content = content.lower()

        has_winner = largest_text_file.lower() in lower_content
        has_size = re.search(rf"\b{largest_text_size}\s*bytes\b", lower_content) is not None or re.search(rf"\b{largest_text_size}\b", lower_content) is not None

        found_text = [name for name in text_like_files if name.lower() in lower_content]
        # Only flag binary files if presented as candidates, not in exclusion context
        binary_in_candidates = False
        for name in binary_files:
            if name.lower() not in lower_content:
                continue
            excl = re.search(
                rf"(exclud|ignor|skip|non.?text|binary|not text).{{0,150}}{re.escape(name.lower())}|"
                rf"{re.escape(name.lower())}.{{0,150}}(exclud|ignor|skip|non.?text|binary|not text)",
                lower_content
            )
            if not excl:
                binary_in_candidates = True
                break
        all_text_present = len(found_text) >= max(len(existing_text_like) - 1, 1)
        no_binary_present = not binary_in_candidates

        if has_winner and has_size and all_text_present and no_binary_present:
            scores["created_correct_report_file"] = 1.0
        elif has_winner and has_size and no_binary_present:
            scores["created_correct_report_file"] = 0.6
        elif has_winner:
            scores["created_correct_report_file"] = 0.25

    # 6. Clear + consistent communication
    largest_semantics = ["largest", "biggest", "most space"]
    if (
        largest_text_file.lower() in combined_assistant
        and any(term in combined_assistant for term in largest_semantics)
        and (str(largest_text_size) in combined_assistant)
    ):
        scores["clear_and_consistent_communication"] = 1.0
    elif largest_text_file.lower() in combined_assistant and any(term in combined_assistant for term in largest_semantics):
        scores["clear_and_consistent_communication"] = 0.75
    elif largest_text_file.lower() in combined_assistant:
        scores["clear_and_consistent_communication"] = 0.5

    return scores
```

## LLM Judge Rubric

### Dimensions

#### 1. File Inspection and Method Quality (Weight: 20%)
- **1.0**: Agent used appropriate commands or tooling to inspect `downloads/`, check file sizes, and gather evidence about file types/content. The approach is efficient and grounded in the actual workspace.
- **0.75**: Agent inspected the directory and sizes competently, but the method is somewhat shallow (e.g. mostly extension-based with limited verification).
- **0.5**: Agent inspected some files or sizes but used an incomplete or brittle method that leaves uncertainty about whether the right set was evaluated.
- **0.25**: Agent made a weak or mostly guessed attempt with minimal inspection.
- **0.0**: Agent did not meaningfully inspect the workspace.

#### 2. Text-like vs Binary Judgment (Weight: 25%)
- **1.0**: Agent correctly excluded binary/non-text files (`.pdf`, `.zip`, `.png`) and correctly included the text-like set relevant to the task. No binary file is treated as a valid candidate.
- **0.75**: Agent got the final candidate set mostly right, with only minor uncertainty in explanation.
- **0.5**: Agent showed partial understanding of the text/binary distinction but made at least one notable classification mistake or relied too much on heuristics without justification.
- **0.25**: Agent attempted filtering but included/excluded important files incorrectly.
- **0.0**: Agent ignored the text-like constraint and solved the wrong problem.

#### 3. Correctness of Final Determination (Weight: 25%)
- **1.0**: Agent correctly identified `annual_sales_report_2024.csv` as the largest text-like file and provided the exact byte size consistent with the workspace.
- **0.75**: Agent identified the correct file but the size reporting is incomplete or slightly imprecise.
- **0.5**: Agent selected a plausible text-like file but got the winner wrong.
- **0.25**: Agent compared some files but never reached a reliable conclusion.
- **0.0**: Agent gave no usable determination.

#### 4. Delivery Artifact Quality (Weight: 15%)
- **1.0**: `downloads/text_file_size_report.txt` exists and contains the correct winner, exact byte size, and a correct comma-separated list of considered text-like files only.
- **0.75**: Report file exists and is mostly correct, with only minor formatting or completeness issues.
- **0.5**: Report file exists but is materially incomplete or partially inconsistent with the actual findings.
- **0.25**: Report file exists but is largely incorrect or missing key required fields.
- **0.0**: No report file was created.

#### 5. Communication, Consistency, and Edge-Case Handling (Weight: 15%)
- **1.0**: Final response is clear, concise, and consistent with the report file; it explicitly answers the requested constrained question (largest text-like file, not overall largest file).
- **0.75**: Response is understandable and mostly consistent, but could be clearer about the constraint or supporting details.
- **0.5**: Response contains the answer but is ambiguous, overly verbose, or weakly aligned with the constraint.
- **0.25**: Response is confusing or partially contradictory.
- **0.0**: Response fails to communicate the result.

### Grading Weights
- automated: 0.6
- llmjudge: 0.4
