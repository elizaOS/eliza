"""
ct_analyzer - Constant-Time Assembly Analyzer

A tool for detecting timing side-channel vulnerabilities in compiled
cryptographic code by analyzing assembly output for variable-time instructions.
"""

from .analyzer import (
    DANGEROUS_INSTRUCTIONS,
    AnalysisReport,
    AssemblyParser,
    ClangCompiler,
    Compiler,
    GCCCompiler,
    GoCompiler,
    OutputFormat,
    RustCompiler,
    Severity,
    Violation,
    analyze_assembly,
    analyze_source,
    detect_language,
    format_report,
    get_compiler,
    get_native_arch,
    normalize_arch,
)

__version__ = "0.1.0"
__all__ = [
    "DANGEROUS_INSTRUCTIONS",
    "AnalysisReport",
    "AssemblyParser",
    "ClangCompiler",
    "Compiler",
    "GCCCompiler",
    "GoCompiler",
    "OutputFormat",
    "RustCompiler",
    "Severity",
    "Violation",
    "analyze_assembly",
    "analyze_source",
    "detect_language",
    "format_report",
    "get_compiler",
    "get_native_arch",
    "normalize_arch",
]
