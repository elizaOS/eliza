from dataclasses import dataclass
from typing import List, Dict, Any
import json
from pathlib import Path
import os
from termcolor import colored
from datetime import datetime
import logging

# Setup logging configuration at module level
def setup_logging():
    # Create logs directory if it doesn't exist
    logs_dir = Path(__file__).parent.parent / "logs"
    logs_dir.mkdir(exist_ok=True)

    # Configure logging
    logging.basicConfig(
        level=logging.DEBUG,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=[
            # File handler for biome.log
            logging.FileHandler(logs_dir / "biome.log", encoding='utf-8'),
            # Console handler for immediate feedback
            logging.StreamHandler()
        ]
    )

# Call setup_logging when module is imported
setup_logging()

@dataclass
class BiomeDiagnostic:
    message: str
    file_path: str
    line: int
    column: int
    severity: str
    rule: str

@dataclass
class BiomeReport:
    plugin_name: str
    total_errors: int
    total_warnings: int
    diagnostics: List[BiomeDiagnostic]
    raw_output: str
    timestamp: str

class BiomeReportGenerator:
    def __init__(self):
        self.report_data = {
            "timestamp": "",
            "plugin_name": "",
            "total_issues": 0,
            "files_analyzed": 0,
            "issues_by_severity": {
                "error": 0,
                "warning": 0,
                "info": 0
            },
            "file_issues": {},
            "logs": []
        }

    def parse_biome_output(self, biome_output: str, plugin_name: str) -> None:
        """Parse the raw Biome output and store it in the report data structure"""
        logger = logging.getLogger(__name__)
        logger.info("=== Starting Biome Output Parsing ===")

        self.report_data["timestamp"] = datetime.now().isoformat()
        self.report_data["plugin_name"] = plugin_name
        self.report_data["raw_output"] = biome_output

        # Parse the text output
        files_processed = []
        diagnostics_limit_msg = None

        # Get the output from node_manager's result
        try:
            result = json.loads(biome_output)
            all_output = result.get("all_output", [])
            error_logs = result.get("error_logs", [])
            self.report_data["logs"] = all_output + error_logs
        except json.JSONDecodeError:
            # If it's not JSON, treat it as raw output
            self.report_data["logs"] = biome_output.splitlines()

        for line in self.report_data["logs"]:
            line = line.strip()

            # Skip empty lines
            if not line:
                continue

            # Check for diagnostics limit message
            if "The number of diagnostics exceeds" in line:
                diagnostics_limit_msg = line
                continue

            # Capture file list
            if line.startswith("  - src/"):
                file = line.strip("  - ")
                files_processed.append(file)
                continue

            # Capture summary counts
            if "Found" in line and ("warnings" in line or "errors" in line):
                try:
                    count = int(line.split()[1])
                    if "warnings" in line:
                        self.report_data["issues_by_severity"]["warning"] = count
                        self.report_data["total_issues"] += count
                    elif "errors" in line:
                        self.report_data["issues_by_severity"]["error"] = count
                        self.report_data["total_issues"] += count
                except ValueError:
                    pass
                continue

        # Update files analyzed count
        self.report_data["files_analyzed"] = len(files_processed)

        # Create a summary entry with all information
        if self.report_data["total_issues"] > 0:
            summary = {
                "severity": "warning",
                "line": 0,
                "column": 0,
                "rule": "summary",
                "message": f"Found {self.report_data['issues_by_severity']['warning']} warnings and {self.report_data['issues_by_severity']['error']} errors",
                "code_snippet": [],
                "additional_info": []
            }

            # Add diagnostics limit message if exists
            if diagnostics_limit_msg:
                summary["additional_info"].append(diagnostics_limit_msg)

            # Add files list
            summary["code_snippet"].extend([
                "Files analyzed:",
                ""] + [f"  - {f}" for f in files_processed])

            if "Summary" not in self.report_data["file_issues"]:
                self.report_data["file_issues"]["Summary"] = []
            self.report_data["file_issues"]["Summary"].insert(0, summary)

    def generate_markdown_report(self) -> str:
        """Generate a formatted markdown report from the parsed data"""
        report = []

        # Header
        report.append(f"# Biome Analysis Report: {self.report_data['plugin_name']}")
        report.append(f"\nGenerated at: {self.report_data['timestamp']}\n")

        # Summary
        report.append("## Summary")
        report.append(f"- Total Issues: {self.report_data['total_issues']}")
        report.append(f"- Files Analyzed: {self.report_data['files_analyzed']}")
        report.append("\nIssues by Severity:")
        for severity, count in self.report_data["issues_by_severity"].items():
            if count > 0:  # Only show non-zero counts
                report.append(f"- {severity.capitalize()}: {count}")

        # Detailed Issues
        report.append("\n## Detailed Issues")

        # First show summary if it exists
        if "Summary" in self.report_data["file_issues"]:
            report.append("\n### Overview")
            for issue in self.report_data["file_issues"]["Summary"]:
                severity_marker = "🔴" if issue["severity"] == "error" else "⚠️"
                report.append(f"\n{severity_marker} **{issue['message']}**")

                # Add any additional info (like diagnostics limit message)
                if issue.get("additional_info"):
                    for info in issue["additional_info"]:
                        report.append(f"\n> {info}")

                # Add file list
                if issue.get("code_snippet"):
                    report.append("\n```")
                    report.extend(issue["code_snippet"])
                    report.append("```")

        # Show all logs
        if self.report_data.get("logs"):
            report.append("\n### Full Diagnostic Output")
            report.append("\n```")
            for log in self.report_data["logs"]:
                report.append(log)
            report.append("```")

        # Then show all other files
        for file_path, issues in self.report_data["file_issues"].items():
            if file_path == "Summary":
                continue

            report.append(f"\n### {file_path}")

            for issue in issues:
                severity_marker = "🔴" if issue["severity"] == "error" else "⚠️"
                location = f"line {issue['line']}, column {issue['column']}"
                rule_text = f"`{issue['rule']}`"
                if issue.get("fixable"):
                    rule_text += " (FIXABLE)"

                report.append(f"\n{severity_marker} **{issue['severity'].upper()}** - {location}")
                report.append(f"- Rule: {rule_text}")

                # Add message with proper formatting
                if issue.get("message"):
                    report.append(f"- Message: {issue['message']}")

                # Add code snippet if available
                if issue.get("code_snippet"):
                    report.append("\n```typescript")
                    report.extend(issue["code_snippet"])
                    report.append("```")

                # Add additional info if available
                if issue.get("additional_info"):
                    report.append("\nℹ️ Additional Information:")
                    for info in issue["additional_info"]:
                        report.append(f"- {info}")

        # Commented out Raw Output section but preserved in code
        """
        report.append("\n## Raw Biome Output")
        report.append("```")
        report.append(self.report_data["raw_output"])
        report.append("```")
        """

        return "\n".join(report)

    def save_report(self, output_dir: Path) -> None:
        """Save the generated report to a markdown file"""
        output_dir.mkdir(parents=True, exist_ok=True)
        report_path = output_dir / f"plugin-{self.report_data['plugin_name']}_report.md"

        with open(report_path, "w", encoding="utf-8") as f:
            f.write(self.generate_markdown_report())

class ReportGenerator:
    def __init__(self, reports_dir: str = "reports"):
        self.reports_dir = Path(reports_dir)
        self.reports_dir.mkdir(exist_ok=True)

        # Setup logging
        logging.basicConfig(
            level=logging.DEBUG,
            format='%(asctime)s - %(levelname)s - %(message)s'
        )
        self.logger = logging.getLogger(__name__)

    def parse_biome_output(self, output: str, plugin_name: str) -> BiomeReport:
        """Parse the raw Biome output into a structured report."""
        try:
            self.logger.debug(f"Parsing Biome output for plugin: {plugin_name}")

            diagnostics: List[BiomeDiagnostic] = []
            error_count = 0
            warning_count = 0

            # Try to parse as JSON first
            try:
                data = json.loads(output)
                if isinstance(data, dict) and "diagnostics" in data:
                    for diag in data["diagnostics"]:
                        severity = diag.get("severity", "error")
                        if severity == "error":
                            error_count += 1
                        elif severity == "warning":
                            warning_count += 1

                        diagnostics.append(BiomeDiagnostic(
                            message=diag.get("message", ""),
                            file_path=diag.get("file", ""),
                            line=diag.get("line", 0),
                            column=diag.get("column", 0),
                            severity=severity,
                            rule=diag.get("rule", "")
                        ))
            except json.JSONDecodeError:
                # Handle non-JSON output by parsing text
                self.logger.debug("Output is not JSON, parsing as text")
                for line in output.split("\n"):
                    if "error" in line.lower():
                        error_count += 1
                    elif "warning" in line.lower():
                        warning_count += 1

                    # Basic text parsing logic
                    if line.strip():
                        diagnostics.append(BiomeDiagnostic(
                            message=line,
                            file_path="",
                            line=0,
                            column=0,
                            severity="error" if "error" in line.lower() else "warning",
                            rule=""
                        ))

            return BiomeReport(
                plugin_name=plugin_name,
                total_errors=error_count,
                total_warnings=warning_count,
                diagnostics=diagnostics,
                raw_output=output,
                timestamp=datetime.now().isoformat()
            )

        except Exception as e:
            self.logger.error(f"Error parsing Biome output: {str(e)}")
            raise

    def generate_markdown_report(self, report: BiomeReport) -> str:
        """Generate a markdown formatted report."""
        try:
            self.logger.debug(f"Generating markdown report for {report.plugin_name}")

            md_content = [
                f"# Biome Analysis Report - {report.plugin_name}",
                f"\nGenerated at: {report.timestamp}",
                f"\n## Summary",
                f"- Total Errors: {report.total_errors}",
                f"- Total Warnings: {report.total_warnings}",
                f"\n## Diagnostics\n"
            ]

            # Group diagnostics by file
            diagnostics_by_file: Dict[str, List[BiomeDiagnostic]] = {}
            for diag in report.diagnostics:
                file_key = diag.file_path or "Unknown File"
                if file_key not in diagnostics_by_file:
                    diagnostics_by_file[file_key] = []
                diagnostics_by_file[file_key].append(diag)

            # Generate file-based sections
            for file_path, file_diagnostics in diagnostics_by_file.items():
                md_content.append(f"\n### {file_path}\n")
                for diag in file_diagnostics:
                    location = f"line {diag.line}, column {diag.column}" if diag.line and diag.column else "location unknown"
                    severity_symbol = "🔴" if diag.severity == "error" else "⚠️"
                    md_content.append(f"- {severity_symbol} **{diag.severity.upper()}** ({location}): {diag.message}")
                    if diag.rule:
                        md_content.append(f"  - Rule: `{diag.rule}`")

            # Commented out Raw Output section but preserved in code
            """
            md_content.extend([
                "\n## Raw Output",
                "\n```",
                report.raw_output,
                "```"
            ])
            """

            return "\n".join(md_content)

        except Exception as e:
            self.logger.error(f"Error generating markdown report: {str(e)}")
            raise

    def save_report(self, report: BiomeReport) -> str:
        """Save the report to a file and return the file path."""
        try:
            report_path = self.reports_dir / f"plugin-{report.plugin_name}_report.md"
            markdown_content = self.generate_markdown_report(report)

            self.logger.info(f"Saving report to {report_path}")
            report_path.write_text(markdown_content, encoding="utf-8")

            print(colored(f"Report generated successfully: {report_path}", "green"))
            return str(report_path)

        except Exception as e:
            self.logger.error(f"Error saving report: {str(e)}")
            raise

    def process_biome_output(self, output: str, plugin_name: str) -> str:
        """Process Biome output and generate a report."""
        try:
            self.logger.info(f"Processing Biome output for plugin: {plugin_name}")
            report = self.parse_biome_output(output, plugin_name)
            return self.save_report(report)

        except Exception as e:
            self.logger.error(f"Error processing Biome output: {str(e)}")
            raise
