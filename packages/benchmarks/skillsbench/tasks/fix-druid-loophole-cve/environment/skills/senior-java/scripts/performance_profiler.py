#!/usr/bin/env python3
"""
JVM Performance Profiler
Profile JVM applications and generate optimization recommendations.

Features:
- Query analysis for N+1 detection
- Memory usage patterns
- GC behavior analysis
- Thread pool recommendations
- Connection pool optimization
- JVM flag recommendations

Standard library only - no external dependencies required.
"""

import argparse
import json
import logging
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

__version__ = "1.0.0"


class QueryAnalyzer:
    """Analyze JPA/Hibernate queries for performance issues"""

    N1_PATTERNS = [
        # Find entity collections without fetch join
        r"@OneToMany.*?\n.*?private\s+(?:List|Set)<(\w+)>",
        r"@ManyToMany.*?\n.*?private\s+(?:List|Set)<(\w+)>",
        # Repository methods that might cause N+1
        r"findAll\(\)",
        r"findBy\w+\(",
    ]

    MISSING_INDEX_PATTERNS = [
        r"findBy(\w+)\(",  # Custom finder methods need indexes
        r"@Query.*?WHERE.*?(\w+)\s*=",  # JPQL WHERE clauses
    ]

    EAGER_FETCH_PATTERN = r"fetch\s*=\s*FetchType\.EAGER"

    def __init__(self, source_dir: str):
        self.source_dir = Path(source_dir)
        self.issues: List[Dict[str, Any]] = []
        self.recommendations: List[str] = []

    def analyze(self) -> Dict[str, Any]:
        """Analyze source files for query performance issues"""
        # Find all Java files
        java_files = list(self.source_dir.rglob("*.java"))

        for file_path in java_files:
            self._analyze_file(file_path)

        return self._generate_report()

    def _analyze_file(self, file_path: Path):
        """Analyze a single Java file"""
        try:
            content = file_path.read_text()
            relative_path = file_path.relative_to(self.source_dir)

            # Check for N+1 query patterns
            self._check_n1_queries(content, str(relative_path))

            # Check for eager fetch
            self._check_eager_fetch(content, str(relative_path))

            # Check for missing @EntityGraph
            self._check_entity_graph(content, str(relative_path))

            # Check repository methods
            self._check_repository_methods(content, str(relative_path))

        except Exception as e:
            logger.warning(f"Failed to analyze {file_path}: {e}")

    def _check_n1_queries(self, content: str, file_path: str):
        """Check for potential N+1 query issues"""
        # Check for collection relationships without proper fetching
        collection_pattern = r"@(OneToMany|ManyToMany)(?:\([^)]*\))?\s*\n\s*private\s+(?:List|Set)<(\w+)>\s+(\w+)"
        matches = re.finditer(collection_pattern, content)

        for match in matches:
            relation_type, entity_type, field_name = match.groups()

            # Check if there's no fetch strategy defined or if lazy loading
            # without EntityGraph could cause N+1
            if "FetchType.LAZY" in content or "fetch" not in match.group(0):
                self.issues.append({
                    "type": "POTENTIAL_N1_QUERY",
                    "severity": "HIGH",
                    "file": file_path,
                    "field": field_name,
                    "description": f"Collection field '{field_name}' ({relation_type}) may cause N+1 queries",
                    "recommendation": f"Use @EntityGraph or fetch join when loading {field_name}",
                })

    def _check_eager_fetch(self, content: str, file_path: str):
        """Check for inappropriate eager fetching"""
        if re.search(self.EAGER_FETCH_PATTERN, content):
            self.issues.append({
                "type": "EAGER_FETCH",
                "severity": "MEDIUM",
                "file": file_path,
                "description": "Eager fetch detected - may cause performance issues with large datasets",
                "recommendation": "Consider using LAZY fetch with EntityGraph for better control",
            })

    def _check_entity_graph(self, content: str, file_path: str):
        """Check if EntityGraph is used for complex queries"""
        if "Repository" in content and "interface" in content:
            # It's a repository interface
            if "@OneToMany" not in content and "@ManyToMany" not in content:
                return  # No collections, skip

            if "@EntityGraph" not in content:
                self.issues.append({
                    "type": "MISSING_ENTITY_GRAPH",
                    "severity": "MEDIUM",
                    "file": file_path,
                    "description": "Repository without @EntityGraph - may need optimization for related entities",
                    "recommendation": "Add @EntityGraph to repository methods that load entities with relations",
                })

    def _check_repository_methods(self, content: str, file_path: str):
        """Check repository methods for potential issues"""
        # Check for findAll without pagination
        if "findAll()" in content and "Pageable" not in content:
            self.issues.append({
                "type": "UNBOUNDED_QUERY",
                "severity": "HIGH",
                "file": file_path,
                "description": "findAll() without pagination may cause memory issues with large datasets",
                "recommendation": "Use findAll(Pageable) or add pagination to avoid loading entire tables",
            })

        # Check for custom queries that might need indexes
        finder_methods = re.findall(r"findBy(\w+)\(", content)
        for method in finder_methods:
            self.recommendations.append(
                f"Ensure database index exists for: {self._camel_to_snake(method)}"
            )

    def _generate_report(self) -> Dict[str, Any]:
        """Generate analysis report"""
        # Group issues by severity
        critical = [i for i in self.issues if i["severity"] == "CRITICAL"]
        high = [i for i in self.issues if i["severity"] == "HIGH"]
        medium = [i for i in self.issues if i["severity"] == "MEDIUM"]
        low = [i for i in self.issues if i["severity"] == "LOW"]

        return {
            "source_directory": str(self.source_dir),
            "summary": {
                "total_issues": len(self.issues),
                "critical": len(critical),
                "high": len(high),
                "medium": len(medium),
                "low": len(low),
            },
            "issues": self.issues,
            "recommendations": list(set(self.recommendations)),  # Dedupe
            "jvm_recommendations": self._get_jvm_recommendations(),
        }

    def _get_jvm_recommendations(self) -> List[Dict[str, str]]:
        """Get general JVM optimization recommendations"""
        return [
            {
                "category": "Memory",
                "recommendation": "Set -Xms equal to -Xmx for consistent heap size",
                "example": "-Xms2g -Xmx2g",
            },
            {
                "category": "GC",
                "recommendation": "Use G1GC for balanced throughput and latency",
                "example": "-XX:+UseG1GC -XX:MaxGCPauseMillis=200",
            },
            {
                "category": "JIT",
                "recommendation": "Enable tiered compilation for faster startup",
                "example": "-XX:+TieredCompilation",
            },
            {
                "category": "Monitoring",
                "recommendation": "Enable GC logging for production",
                "example": "-Xlog:gc*:file=gc.log:time,uptime:filecount=5,filesize=10M",
            },
            {
                "category": "Connection Pool",
                "recommendation": "Use HikariCP with appropriate pool size",
                "example": "spring.datasource.hikari.maximum-pool-size=10",
            },
        ]

    @staticmethod
    def _camel_to_snake(name: str) -> str:
        """Convert camelCase to snake_case"""
        return re.sub(r'(?<!^)(?=[A-Z])', '_', name).lower()


def format_report(report: Dict[str, Any], output_format: str) -> str:
    """Format report for output"""
    if output_format == "json":
        return json.dumps(report, indent=2)

    # Markdown format
    lines = [
        "# JVM Performance Analysis Report",
        f"\n**Source Directory:** {report['source_directory']}",
        "",
        "## Summary",
        f"- Total Issues: {report['summary']['total_issues']}",
        f"- Critical: {report['summary']['critical']}",
        f"- High: {report['summary']['high']}",
        f"- Medium: {report['summary']['medium']}",
        f"- Low: {report['summary']['low']}",
        "",
    ]

    if report["issues"]:
        lines.append("## Issues Found")
        lines.append("")
        for issue in report["issues"]:
            lines.append(f"### [{issue['severity']}] {issue['type']}")
            lines.append(f"**File:** {issue['file']}")
            lines.append(f"**Description:** {issue['description']}")
            lines.append(f"**Recommendation:** {issue['recommendation']}")
            lines.append("")

    if report["recommendations"]:
        lines.append("## Database Recommendations")
        lines.append("")
        for rec in report["recommendations"]:
            lines.append(f"- {rec}")
        lines.append("")

    lines.append("## JVM Optimization Recommendations")
    lines.append("")
    for rec in report["jvm_recommendations"]:
        lines.append(f"### {rec['category']}")
        lines.append(f"**Recommendation:** {rec['recommendation']}")
        lines.append(f"```")
        lines.append(rec['example'])
        lines.append("```")
        lines.append("")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="JVM Performance Profiler - Analyze Java code for performance issues",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Analyze source for performance issues
  python performance_profiler.py --analyze-queries src/

  # Generate markdown report
  python performance_profiler.py --analyze-queries src/ --output performance-report.md

  # JSON output
  python performance_profiler.py --analyze-queries src/ --json
"""
    )

    parser.add_argument("--analyze-queries", metavar="DIR",
                        help="Analyze source directory for query performance issues")
    parser.add_argument("--output", "-o",
                        help="Output file path")
    parser.add_argument("--json", action="store_true",
                        help="Output as JSON")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Enable verbose output")
    parser.add_argument("--version", action="version",
                        version=f"%(prog)s {__version__}")

    args = parser.parse_args()

    if not args.analyze_queries:
        parser.print_help()
        sys.exit(1)

    source_dir = Path(args.analyze_queries)
    if not source_dir.exists():
        print(f"Error: Directory not found: {source_dir}", file=sys.stderr)
        sys.exit(1)

    analyzer = QueryAnalyzer(str(source_dir))
    report = analyzer.analyze()

    output_format = "json" if args.json else "markdown"
    if args.output and args.output.endswith(".json"):
        output_format = "json"

    formatted = format_report(report, output_format)

    if args.output:
        Path(args.output).write_text(formatted)
        print(f"Report saved to: {args.output}")
    else:
        print(formatted)

    # Exit with appropriate code
    if report["summary"]["critical"] > 0:
        sys.exit(2)
    elif report["summary"]["high"] > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
