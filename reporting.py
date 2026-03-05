from collections import defaultdict
from dataclasses import dataclass
from typing import List, Dict, Any

@dataclass
class Metrics:
    overall_score: float
    ast_score: float
    exec_score: float

@dataclass
class BenchmarkResult:
    overall_score: float
    ast_score: float
    exec_score: float

@dataclass
class BFCLBenchmarkResults:
    results: List[BenchmarkResult]

class BFCLReporter:
    def __init__(self):
        self.results = []

    def add_result(self, rank, metrics):
        self.results.append((rank, metrics))
    
    def generate_report(self):
        report_lines = []
        for rank, metrics in self.results:
            report_lines.append(f"Rank {rank}: Overall: {metrics.overall_score:.2f}, AST: {metrics.ast_score:.2f}, Exec: {metrics.exec_score:.2f}")
        return "\n".join(report_lines)

class Report:
    def __init__(self):
        self.data = defaultdict(list)

    def add_entry(self, category, entry):
        self.data[category].append(entry)

    def print_report(self):  # Changed method name for consistency
        report_lines = []
        for category, entries in self.data.items():
            report_lines.append(f'Category: {category}')
            for entry in entries:
                report_lines.append(f' - {entry}')
        print("\n".join(report_lines))  # Changed to print directly

def print_results(results: BFCLBenchmarkResults):
    reporter = BFCLReporter()
    for rank, result in enumerate(results.results, start=1):  # Use .results, start=1
        metrics = Metrics(result.overall_score, 
                         float(result.ast_match),  # Convert bool to float
                         float(result.exec_success))  # Convert bool to float
        reporter.add_result(rank, metrics)
    print(reporter.generate_report())
