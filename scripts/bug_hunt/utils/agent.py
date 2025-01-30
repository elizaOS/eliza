from typing import List, Dict, Any, Optional
import logging
from pathlib import Path
from rich.console import Console
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn
import json
from datetime import datetime
from phi.agent import Agent
from phi.model.deepseek import DeepSeekChat
import os
import sys
sys.path.append(str(Path(__file__).parent.parent))
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
# Initialize Rich console
console = Console()

# Configure logger
logger = logging.getLogger("biome_workflow")

class BiomeWorkflow:
    def __init__(self):

        # LLD (Low Level Design) agent for architecture and design analysis
        self.biome_agent = Agent(
            name="Biome Agent",
            model=DeepSeekChat(),
            instructions=[
                "You are an expert code quality analyst specializing in Biome linter reports and code optimization.",
                "Your expertise lies in analyzing Biome linter outputs and providing actionable solutions.",
                "Core Analysis Areas:",
                "1. Linter Report Analysis:",
                    "- Parse and categorize Biome warnings and errors",
                    "- Identify patterns in reported issues",
                    "- Prioritize fixes based on severity",
                    "- Track recurring code quality issues",
                    "- Analyze impact of reported problems",
                "2. Code Optimization:",
                    "- Propose specific fixes for linter warnings",
                    "- Recommend code style improvements",
                    "- Suggest refactoring opportunities",
                    "- Provide examples of optimized code",
                    "- Consider performance implications",
                "3. Best Practices Implementation:",
                    "- Align solutions with coding standards",
                    "- Recommend modern syntax alternatives",
                    "- Suggest consistent code patterns",
                    "- Promote maintainable code structure",
                    "- Guide on error prevention",
                "4. Technical Debt Management:",
                    "- Identify technical debt indicators",
                    "- Propose debt reduction strategies",
                    "- Prioritize critical improvements",
                    "- Track recurring patterns",
                    "- Plan incremental fixes",
                "5. Solution Guidance:",
                    "- Provide step-by-step fix instructions",
                    "- Include code examples for fixes",
                    "- Explain reasoning behind solutions",
                    "- Consider implementation complexity",
                    "- Suggest testing approaches"
            ],
            guidelines=[
                "Focus on practical, implementable solutions for Biome warnings",
                "Prioritize fixes based on severity and impact",
                "Provide clear code examples for each solution",
                "Consider the codebase context when suggesting fixes",
                "Balance quick wins with long-term improvements",
                "Highlight critical issues first",
                "Include before/after code comparisons",
                "Consider maintainability in solutions",
                "Align with modern coding standards",
                "Suggest automated fix options when available"
            ],
            expected_output="""A comprehensive Biome analysis report containing:

1. Issue Summary:
   - Total warnings and errors
   - Severity breakdown
   - Pattern analysis
   - Critical issues
   - Quick wins identified

2. Detailed Solutions:
   - Specific fixes per issue
   - Code examples
   - Implementation steps
   - Testing recommendations
   - Performance considerations

3. Best Practices Alignment:
   - Style guide compliance
   - Modern syntax adoption
   - Pattern consistency
   - Error prevention
   - Maintainability improvements

4. Implementation Strategy:
   - Prioritized fix order
   - Effort estimation
   - Dependencies
   - Testing requirements
   - Rollout considerations

5. Next Steps:
   - Immediate actions
   - Automated fixes
   - Manual improvements
   - Validation steps
   - Follow-up checks

Format:
- Clear issue-solution mapping
- Executable code examples
- Implementation priorities
- Testing guidelines
- Validation steps""",
            reasoning=True,
            markdown=True,
            debug_mode=True,
            monitoring=True,
        )

    def generate_final_response(self, biome_data: str) -> Dict[str, Any]:
        """Generate final response using PR reasoning agent to analyze Biome report"""
        try:
            logger.info("Generating final PR analysis")
            result = self.biome_agent.run(biome_data)

            # Handle the response
            if hasattr(result, 'content'):
                content = result.content
            elif isinstance(result, dict) and 'content' in result:
                content = result['content']
            elif isinstance(result, str):
                content = result
            else:
                content = str(result)

            # Log the final analysis
            logger.info("Final analysis generated")
            console.print(Panel(content, title="Final PR Analysis", style="blue"))

            return {
                "status": "success",
                "final_response": content,
                "analysis_timestamp": datetime.now().isoformat(),
                "analysis_type": "biome_workflow"
            }

        except Exception as e:
            error_msg = f"Error generating final response: {str(e)}"
            logger.error(error_msg)
            return {"error": error_msg, "status": "failed"}

    def run(self) -> Dict[str, Any]:
        """Run the complete analysis workflow for all reports"""
        logger.info("Starting analysis workflow for reports")

        try:
            results = []

            # Process each report file in the reports directory
            for report_file in PR_REPORTS_PATH.glob("*.json"):
                logger.info(f"Processing report file: {report_file}")

                try:
                    with open(report_file, encoding="utf-8") as f:
                        biome_data = f.read()

                    # Generate analysis for this report
                    final_response = self.generate_final_response(biome_data)
                    results.append({
                        "file": str(report_file),
                        "analysis": final_response
                    })

                except Exception as e:
                    logger.error(f"Error processing file {report_file}: {str(e)}")
                    continue

            return {
                "results": results,
                "status": "success"
            }

        except Exception as e:
            error_msg = f"Analysis workflow failed: {str(e)}"
            logger.error(error_msg)
            return {"error": error_msg, "status": "failed"}

if __name__ == "__main__":
    # Configure paths
    PR_REPORTS_PATH = Path("/Users/ilessio/dev-agents/ELIZA_FIX/eliza_aiflow/scripts/bug_hunt/reports")

    choice = input("\nEnter your choice (1-2): ")

    if choice == "1":
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            transient=True,
        ) as progress:
            progress.add_task(description="Initializing analysis...", total=None)
            workflow = BiomeWorkflow()
            result = workflow.run()

        if result.get("status") == "success":
            # Save the consolidated report
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            report_file = PR_REPORTS_PATH / f"consolidated_analysis_{timestamp}.json"

            with open(report_file, "w", encoding="utf-8") as f:
                json.dump(result, f, indent=2, ensure_ascii=False)

            console.print("\n[green]Analysis completed successfully![/green]")
            console.print(f"[blue]Consolidated report saved to: {report_file}[/blue]")

            # Display summary for each analyzed file
            console.print("\n[bold]Analysis Summary:[/bold]")
            for file_result in result["results"]:
                console.print(Panel(
                    file_result["analysis"].get("final_response", "No summary available"),
                    title=f"Analysis Results for {Path(file_result['file']).name}",
                    style="cyan"
                ))
        else:
            console.print(f"\n[red]Analysis failed: {result.get('error', 'Unknown error')}[/red]")

    elif choice == "2":
        console.print("[yellow]Exiting...[/yellow]")
    else:
        console.print("[red]Invalid choice![/red]")



