import os
import subprocess
from pathlib import Path
from typing import Optional, Dict, Any
import json
import nodeenv
import logging

# Get logger for this module
logger = logging.getLogger(__name__)

class NodeManager:
    """Manages Node.js tools for JavaScript/TypeScript analysis"""

    def __init__(self, work_dir: str = "."):
        self.work_dir = Path(work_dir).resolve()
        self.package_json = self.work_dir / "package.json"
        self.logger = logging.getLogger(__name__)
        self.logger.debug(f"Initialized NodeManager with work_dir: {work_dir}")

    def run_biome(self, target_path: str, config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Run Biome analysis on target path"""
        try:
            self.logger.info("=== Starting Biome Analysis ===")
            self.logger.info(f"Target path: {target_path}")
            self.logger.info(f"Working directory: {self.work_dir}")

            # Change to the plugin directory first
            plugin_dir = Path(target_path)

            # Base command for checking only (no fixes)
            cmd = [
                "pnpm",
                "biome",
                "check",
                "src",  # Just check src directory
                "--verbose"
            ]

            self.logger.info("=== Command Configuration ===")
            self.logger.info(f"Initial command: {' '.join(cmd)}")
            self.logger.info(f"Will execute in directory: {plugin_dir}")

            result = subprocess.run(
                cmd,
                cwd=str(plugin_dir),  # Execute in plugin directory
                capture_output=True,
                text=True,
                env={**os.environ}
            )

            self.logger.info("=== Biome Execution Results ===")
            self.logger.info(f"Exit code: {result.returncode}")

            # Store all output and errors
            all_output = []
            error_logs = []

            # Log all output for debugging
            if result.stdout:
                self.logger.info("=== Biome Output ===")
                for line in result.stdout.splitlines():
                    self.logger.info(f"OUT: {line}")
                    all_output.append(line)

            if result.stderr:
                self.logger.error("=== Biome Errors ===")
                for line in result.stderr.splitlines():
                    self.logger.error(f"ERR: {line}")
                    error_logs.append(line)

            # Parse the output into structured format
            diagnostics = self._parse_biome_verbose_output(result.stdout)

            self.logger.info("=== Parsing Results ===")
            self.logger.info(f"Found {len(diagnostics)} issues")

            return {
                "success": result.returncode == 0,
                "output": result.stdout,
                "errors": result.stderr,
                "diagnostics": diagnostics,
                "raw_output": f"STDOUT:\n{result.stdout}\n\nSTDERR:\n{result.stderr}",
                "all_output": all_output,
                "error_logs": error_logs
            }

        except subprocess.CalledProcessError as e:
            self.logger.error(f"=== Biome Execution Failed ===")
            self.logger.error(f"Error: {str(e)}")
            self.logger.error(f"Command: {e.cmd}")
            self.logger.error(f"Return code: {e.returncode}")
            if e.stdout:
                self.logger.error(f"Stdout: {e.stdout}")
            if e.stderr:
                self.logger.error(f"Stderr: {e.stderr}")
            return {
                "success": False,
                "output": e.stdout if e.stdout else "",
                "errors": str(e),
                "diagnostics": [],
                "raw_output": f"STDOUT:\n{e.stdout if e.stdout else ''}\n\nSTDERR:\n{e.stderr if e.stderr else ''}",
                "all_output": [],
                "error_logs": [str(e)]
            }
        except Exception as e:
            self.logger.error(f"=== Unexpected Error ===")
            self.logger.error(f"Type: {type(e).__name__}")
            self.logger.error(f"Error: {str(e)}")
            import traceback
            self.logger.error(f"Traceback: {traceback.format_exc()}")
            return {
                "success": False,
                "output": "",
                "errors": str(e),
                "diagnostics": [],
                "raw_output": f"ERROR:\n{str(e)}\n\n{traceback.format_exc()}",
                "all_output": [],
                "error_logs": [str(e), traceback.format_exc()]
            }

    def run_dependency_check(self, target_path: str) -> Dict[str, Any]:
        """Run dependency analysis using pnpm-based madge"""
        try:
            cmd = [
                "pnpm",
                "dlx",
                "madge",
                "--json",
                "--warning",
                "--circular",
                target_path
            ]

            result = subprocess.run(
                cmd,
                cwd=str(self.work_dir),
                capture_output=True,
                text=True,
                env={**os.environ}
            )
            return {
                "success": result.returncode == 0,
                "dependencies": json.loads(result.stdout) if result.stdout else {},
                "errors": result.stderr
            }
        except subprocess.CalledProcessError as e:
            self.logger.error(f"Dependency check failed: {str(e)}")
            return {
                "success": False,
                "dependencies": {},
                "errors": str(e)
            }

    def analyze_typescript(self, target_path: str, config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Run comprehensive TypeScript analysis"""
        results = {
            "success": True,
            "results": {
                "biome": self.run_biome(target_path, config),
                "dependencies": self.run_dependency_check(target_path)
            }
        }

        # Check overall success
        results["success"] = all(
            results["results"][key].get("success", False)
            for key in results["results"]
        )

        return results

    def _parse_biome_verbose_output(self, output: str) -> list[Dict[str, Any]]:
        """Parse Biome verbose output into structured format"""
        diagnostics = []
        current_diagnostic = None
        current_file = None
        current_message = []
        in_error_block = False
        summary_info = {
            "total_warnings": 0,
            "total_errors": 0,
            "files_processed": []
        }

        lines = output.splitlines()
        i = 0
        while i < len(lines):
            line = lines[i].strip()
            if not line:
                i += 1
                continue

            # Capture summary information
            if "Found" in line and ("warnings" in line or "errors" in line):
                try:
                    count = int(line.split()[1])
                    if "warnings" in line:
                        summary_info["total_warnings"] = count
                    elif "errors" in line:
                        summary_info["total_errors"] = count
                except ValueError:
                    pass

            # Capture processed files
            elif line.startswith("- src/"):
                summary_info["files_processed"].append(line.strip("- "))

            # Check for file location and rule
            elif '.ts:' in line and not line.startswith('i '):
                # New diagnostic starts
                if current_diagnostic:
                    current_diagnostic["message"] = "\n".join(current_message)
                    diagnostics.append(current_diagnostic)
                    current_message = []

                parts = line.split(" ", 1)
                location = parts[0]
                rule = parts[1] if len(parts) > 1 else ""

                file_parts = location.split(":")
                current_diagnostic = {
                    "file": file_parts[0],
                    "line": int(file_parts[1]) if len(file_parts) > 1 else 0,
                    "column": int(file_parts[2]) if len(file_parts) > 2 else 0,
                    "rule": rule.split("  ")[0] if "  " in rule else rule,
                    "severity": "error" if "error" in rule.lower() else "warning",
                    "message": "",
                    "code_snippet": []
                }
                in_error_block = True

            # Capture error messages and code snippets
            elif in_error_block:
                if line.startswith(("  !", "  i ")):  # Main error message
                    current_message.append(line.replace("  ! ", "").replace("  i ", ""))
                elif line.startswith(("  >", "     ")):  # Code snippet
                    if current_diagnostic:
                        current_diagnostic["code_snippet"].append(line)
                elif line.startswith("  -") or line.startswith("  +"): # Fix suggestions
                    if current_diagnostic:
                        current_diagnostic["code_snippet"].append(line)
                else:
                    in_error_block = False

            i += 1

        # Add the last diagnostic if exists
        if current_diagnostic:
            current_diagnostic["message"] = "\n".join(current_message)
            diagnostics.append(current_diagnostic)

        # If we have no diagnostics but have summary info, create a summary diagnostic
        if not diagnostics and (summary_info["total_warnings"] > 0 or summary_info["total_errors"] > 0):
            summary_diagnostic = {
                "file": "Summary",
                "line": 0,
                "column": 0,
                "rule": "multiple-issues",
                "severity": "warning",
                "message": f"Found {summary_info['total_warnings']} warnings and {summary_info['total_errors']} errors across {len(summary_info['files_processed'])} files",
                "code_snippet": [f"Affected files:"] + [f"  - {f}" for f in summary_info['files_processed']]
            }
            diagnostics.append(summary_diagnostic)

        return diagnostics

if __name__ == "__main__":
    # Test the Node manager
    node_mgr = NodeManager()
    result = node_mgr.run_biome("../../packages/plugin-test")
    print(json.dumps(result, indent=2))