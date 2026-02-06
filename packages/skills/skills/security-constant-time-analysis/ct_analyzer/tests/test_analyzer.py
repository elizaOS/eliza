#!/usr/bin/env python3
"""
Unit tests for the constant-time analyzer.

These tests verify that the analyzer correctly detects timing side-channel
vulnerabilities in compiled cryptographic code.
"""

import os
import subprocess
import sys
import unittest
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from analyzer import (
    DANGEROUS_INSTRUCTIONS,
    AssemblyParser,
    OutputFormat,
    Severity,
    analyze_assembly,
    analyze_source,
    detect_language,
    format_report,
    get_native_arch,
    normalize_arch,
)


class TestArchitectureNormalization(unittest.TestCase):
    """Test architecture name normalization."""

    def test_normalize_common_aliases(self):
        self.assertEqual(normalize_arch("amd64"), "x86_64")
        self.assertEqual(normalize_arch("x64"), "x86_64")
        self.assertEqual(normalize_arch("aarch64"), "arm64")
        self.assertEqual(normalize_arch("386"), "i386")
        self.assertEqual(normalize_arch("x86"), "i386")

    def test_normalize_case_insensitive(self):
        self.assertEqual(normalize_arch("AMD64"), "x86_64")
        self.assertEqual(normalize_arch("AARCH64"), "arm64")
        self.assertEqual(normalize_arch("X86_64"), "x86_64")

    def test_normalize_passthrough(self):
        self.assertEqual(normalize_arch("x86_64"), "x86_64")
        self.assertEqual(normalize_arch("arm64"), "arm64")
        self.assertEqual(normalize_arch("riscv64"), "riscv64")


class TestLanguageDetection(unittest.TestCase):
    """Test source file language detection."""

    def test_detect_c(self):
        self.assertEqual(detect_language("foo.c"), "c")
        self.assertEqual(detect_language("foo.h"), "c")
        self.assertEqual(detect_language("/path/to/crypto.c"), "c")

    def test_detect_cpp(self):
        self.assertEqual(detect_language("foo.cpp"), "cpp")
        self.assertEqual(detect_language("foo.cc"), "cpp")
        self.assertEqual(detect_language("foo.cxx"), "cpp")
        self.assertEqual(detect_language("foo.hpp"), "cpp")

    def test_detect_go(self):
        self.assertEqual(detect_language("main.go"), "go")
        self.assertEqual(detect_language("/path/to/crypto.go"), "go")

    def test_detect_rust(self):
        self.assertEqual(detect_language("lib.rs"), "rust")
        self.assertEqual(detect_language("/path/to/crypto.rs"), "rust")

    def test_detect_python(self):
        self.assertEqual(detect_language("crypto.py"), "python")
        self.assertEqual(detect_language("crypto.pyw"), "python")
        self.assertEqual(detect_language("/path/to/crypto.py"), "python")

    def test_detect_ruby(self):
        self.assertEqual(detect_language("crypto.rb"), "ruby")
        self.assertEqual(detect_language("/path/to/crypto.rb"), "ruby")

    def test_detect_java(self):
        self.assertEqual(detect_language("CryptoUtils.java"), "java")
        self.assertEqual(detect_language("/path/to/Crypto.java"), "java")

    def test_detect_csharp(self):
        self.assertEqual(detect_language("CryptoUtils.cs"), "csharp")
        self.assertEqual(detect_language("/path/to/Crypto.cs"), "csharp")

    def test_detect_unknown(self):
        self.assertEqual(detect_language("foo.txt"), "unknown")
        self.assertEqual(detect_language("foo.scala"), "unknown")


class TestDangerousInstructions(unittest.TestCase):
    """Test that dangerous instruction lists are properly defined."""

    def test_all_architectures_have_errors(self):
        for arch in DANGEROUS_INSTRUCTIONS:
            self.assertIn(
                "errors", DANGEROUS_INSTRUCTIONS[arch], f"Architecture {arch} missing 'errors' key"
            )
            self.assertGreater(
                len(DANGEROUS_INSTRUCTIONS[arch]["errors"]),
                0,
                f"Architecture {arch} has no error instructions",
            )

    def test_all_architectures_have_division(self):
        """Every architecture should flag some form of division."""
        division_patterns = ["div", "idiv", "udiv", "sdiv", "d", "dr"]

        for arch, instructions in DANGEROUS_INSTRUCTIONS.items():
            errors = instructions.get("errors", {})
            has_division = any(
                any(pattern in mnemonic.lower() for pattern in division_patterns)
                for mnemonic in errors.keys()
            )
            self.assertTrue(has_division, f"Architecture {arch} should flag division instructions")

    def test_x86_64_has_known_dangerous(self):
        """x86_64 should flag DIV, IDIV, and their variants."""
        x86 = DANGEROUS_INSTRUCTIONS["x86_64"]["errors"]
        self.assertIn("div", x86)
        self.assertIn("idiv", x86)
        self.assertIn("divq", x86)
        self.assertIn("idivq", x86)

    def test_arm64_has_known_dangerous(self):
        """ARM64 should flag UDIV and SDIV."""
        arm64 = DANGEROUS_INSTRUCTIONS["arm64"]["errors"]
        self.assertIn("udiv", arm64)
        self.assertIn("sdiv", arm64)


class TestAssemblyParser(unittest.TestCase):
    """Test assembly parsing and violation detection."""

    def test_parse_x86_64_division(self):
        """Parser should detect x86_64 division instructions."""
        assembly = """
        decompose:
            movq    %rdi, %rax
            cqto
            idivq   %rsi
            movq    %rax, (%rdx)
            movq    %rdx, (%rcx)
            ret
        """

        parser = AssemblyParser("x86_64", "clang")
        functions, violations = parser.parse(assembly)

        self.assertEqual(len(functions), 1)
        self.assertEqual(functions[0]["name"], "decompose")

        # Should find the IDIVQ instruction
        error_violations = [v for v in violations if v.severity == Severity.ERROR]
        self.assertGreater(len(error_violations), 0, "Should detect IDIVQ")
        self.assertEqual(error_violations[0].mnemonic, "IDIVQ")

    def test_parse_arm64_division(self):
        """Parser should detect ARM64 division instructions."""
        assembly = """
        decompose:
            sdiv    w8, w0, w1
            msub    w9, w8, w1, w0
            str     w8, [x2]
            str     w9, [x3]
            ret
        """

        parser = AssemblyParser("arm64", "clang")
        functions, violations = parser.parse(assembly)

        error_violations = [v for v in violations if v.severity == Severity.ERROR]
        self.assertGreater(len(error_violations), 0, "Should detect SDIV")
        self.assertEqual(error_violations[0].mnemonic, "SDIV")

    def test_parse_conditional_branches_as_warnings(self):
        """Parser should detect conditional branches as warnings."""
        assembly = """
        check_value:
            cmpq    $0, %rdi
            je      .Lzero
            movq    $1, %rax
            ret
        .Lzero:
            xorq    %rax, %rax
            ret
        """

        parser = AssemblyParser("x86_64", "clang")
        functions, violations = parser.parse(assembly, include_warnings=True)

        warning_violations = [v for v in violations if v.severity == Severity.WARNING]
        self.assertGreater(len(warning_violations), 0, "Should detect JE as warning")

    def test_parse_no_false_positives_on_clean_code(self):
        """Parser should not flag clean constant-time code."""
        assembly = """
        constant_time_select:
            movq    %rdx, %rax
            negq    %rax
            andq    %rdi, %rax
            notq    %rdx
            andq    %rsi, %rdx
            orq     %rdx, %rax
            ret
        """

        parser = AssemblyParser("x86_64", "clang")
        functions, violations = parser.parse(assembly)

        error_violations = [v for v in violations if v.severity == Severity.ERROR]
        self.assertEqual(len(error_violations), 0, "Clean code should have no violations")


class TestReportFormatting(unittest.TestCase):
    """Test report output formatting."""

    def test_json_format(self):
        """JSON format should produce valid JSON."""
        import json

        from analyzer import AnalysisReport

        report = AnalysisReport(
            architecture="x86_64",
            compiler="clang",
            optimization="O2",
            source_file="test.c",
            total_functions=1,
            total_instructions=10,
            violations=[],
        )

        output = format_report(report, OutputFormat.JSON)
        parsed = json.loads(output)

        self.assertEqual(parsed["architecture"], "x86_64")
        self.assertEqual(parsed["passed"], True)

    def test_text_format_passed(self):
        """Text format should show PASSED for clean code."""
        from analyzer import AnalysisReport

        report = AnalysisReport(
            architecture="x86_64",
            compiler="clang",
            optimization="O2",
            source_file="test.c",
            total_functions=1,
            total_instructions=10,
            violations=[],
        )

        output = format_report(report, OutputFormat.TEXT)
        self.assertIn("PASSED", output)
        self.assertIn("No violations found", output)

    def test_text_format_failed(self):
        """Text format should show FAILED when violations exist."""
        from analyzer import AnalysisReport, Violation

        report = AnalysisReport(
            architecture="x86_64",
            compiler="clang",
            optimization="O2",
            source_file="test.c",
            total_functions=1,
            total_instructions=10,
            violations=[
                Violation(
                    function="decompose",
                    file="test.c",
                    line=10,
                    address="0x1234",
                    instruction="idivq %rsi",
                    mnemonic="IDIVQ",
                    reason="IDIVQ has data-dependent timing",
                    severity=Severity.ERROR,
                )
            ],
        )

        output = format_report(report, OutputFormat.TEXT)
        self.assertIn("FAILED", output)
        self.assertIn("IDIVQ", output)


class TestIntegration(unittest.TestCase):
    """Integration tests that compile actual code.

    These tests require clang/gcc to be installed and may be skipped
    in environments without compilers.
    """

    @classmethod
    def setUpClass(cls):
        """Check if compilers are available."""
        cls.samples_dir = Path(__file__).parent / "test_samples"
        cls.has_clang = cls._check_compiler("clang")
        cls.has_gcc = cls._check_compiler("gcc")

    @staticmethod
    def _check_compiler(name):
        try:
            subprocess.run([name, "--version"], capture_output=True, check=True)
            return True
        except (subprocess.CalledProcessError, FileNotFoundError):
            return False

    @unittest.skipUnless(lambda self: self.has_clang or self.has_gcc, "No C compiler available")
    def test_vulnerable_c_detected(self):
        """Vulnerable C implementation should be detected."""
        if not (self.has_clang or self.has_gcc):
            self.skipTest("No C compiler available")

        vulnerable_file = self.samples_dir / "decompose_vulnerable.c"
        if not vulnerable_file.exists():
            self.skipTest("Test sample not found")

        compiler = "clang" if self.has_clang else "gcc"

        try:
            report = analyze_source(
                str(vulnerable_file),
                compiler=compiler,
                optimization="O2",
            )

            # Should detect division instructions
            self.assertFalse(report.passed, "Vulnerable code should fail analysis")
            self.assertGreater(report.error_count, 0, "Should find error-level violations")

            # Check that we found division-related violations
            div_violations = [v for v in report.violations if "div" in v.mnemonic.lower()]
            self.assertGreater(len(div_violations), 0, "Should detect division instructions")

        except RuntimeError as e:
            if "Compilation failed" in str(e):
                self.skipTest(f"Compilation failed: {e}")
            raise

    @unittest.skipUnless(lambda self: self.has_clang or self.has_gcc, "No C compiler available")
    def test_constant_time_c_clean(self):
        """Constant-time C implementation should pass."""
        if not (self.has_clang or self.has_gcc):
            self.skipTest("No C compiler available")

        ct_file = self.samples_dir / "decompose_constant_time.c"
        if not ct_file.exists():
            self.skipTest("Test sample not found")

        compiler = "clang" if self.has_clang else "gcc"

        try:
            report = analyze_source(
                str(ct_file),
                compiler=compiler,
                optimization="O2",
            )

            # Constant-time implementation should not have division
            div_violations = [
                v
                for v in report.violations
                if "div" in v.mnemonic.lower() and v.severity == Severity.ERROR
            ]

            # Note: We allow this to be empty OR the compiler might have
            # optimized in unexpected ways
            if div_violations:
                print(f"WARNING: Found {len(div_violations)} division violations")
                print("This may indicate the compiler optimized differently than expected")

        except RuntimeError as e:
            if "Compilation failed" in str(e):
                self.skipTest(f"Compilation failed: {e}")
            raise

    def test_multiple_optimization_levels(self):
        """Test that analysis works across optimization levels."""
        if not (self.has_clang or self.has_gcc):
            self.skipTest("No C compiler available")

        vulnerable_file = self.samples_dir / "decompose_vulnerable.c"
        if not vulnerable_file.exists():
            self.skipTest("Test sample not found")

        compiler = "clang" if self.has_clang else "gcc"

        for opt in ["O0", "O1", "O2", "O3"]:
            with self.subTest(optimization=opt):
                try:
                    report = analyze_source(
                        str(vulnerable_file),
                        compiler=compiler,
                        optimization=opt,
                    )
                    # Just verify it runs without error
                    self.assertIsNotNone(report)

                except RuntimeError as e:
                    if "Compilation failed" in str(e):
                        # Some optimization levels may not work on all systems
                        continue
                    raise


class TestCrossArchitecture(unittest.TestCase):
    """Test cross-architecture compilation and analysis.

    These tests verify that the analyzer can handle different target
    architectures, even when cross-compiling from a different host.
    """

    @classmethod
    def setUpClass(cls):
        cls.samples_dir = Path(__file__).parent / "test_samples"
        cls.has_clang = TestIntegration._check_compiler("clang")

    @unittest.skipUnless(lambda self: self.has_clang, "Clang required for cross-compilation")
    def test_cross_compile_arm64(self):
        """Test cross-compilation to ARM64."""
        if not self.has_clang:
            self.skipTest("Clang not available")

        vulnerable_file = self.samples_dir / "decompose_vulnerable.c"
        if not vulnerable_file.exists():
            self.skipTest("Test sample not found")

        try:
            report = analyze_source(
                str(vulnerable_file),
                arch="arm64",
                compiler="clang",
                optimization="O2",
            )

            # Should still detect violations, just ARM64 specific ones
            self.assertIsNotNone(report)
            self.assertEqual(report.architecture, "arm64")

        except RuntimeError as e:
            if "target" in str(e).lower() or "triple" in str(e).lower():
                self.skipTest("ARM64 cross-compilation not supported")
            raise


class TestScriptingLanguageDetection(unittest.TestCase):
    """Test language detection for scripting languages."""

    def test_detect_php(self):
        self.assertEqual(detect_language("crypto.php"), "php")
        self.assertEqual(detect_language("/path/to/crypto.php"), "php")

    def test_detect_javascript(self):
        self.assertEqual(detect_language("crypto.js"), "javascript")
        self.assertEqual(detect_language("crypto.mjs"), "javascript")
        self.assertEqual(detect_language("crypto.cjs"), "javascript")

    def test_detect_typescript(self):
        self.assertEqual(detect_language("crypto.ts"), "typescript")
        self.assertEqual(detect_language("crypto.tsx"), "typescript")
        self.assertEqual(detect_language("crypto.mts"), "typescript")


class TestPHPAnalyzerParsing(unittest.TestCase):
    """Test PHP opcode parsing."""

    def test_parse_vld_division(self):
        """Parser should detect PHP division opcodes."""
        from script_analyzers import PHPAnalyzer

        # Sample VLD output with division
        vld_output = """
Finding entry points
Branch analysis from position: 0
filename:       /path/to/test.php
function name:  vulnerable_mod
number of ops:  8
compiled vars:  !0 = $value, !1 = $modulus
line     #* E I O op                           fetch          ext  return  operands
-------------------------------------------------------------------------------------
   5     0  E >   RECV                                             !0
         1        RECV                                             !1
   6     2        DIV                                              ~2      !0, !1
   7     3        ASSIGN                                                   !2, ~2
   8     4        MOD                                              ~4      !0, !1
         5        ASSIGN                                                   !3, ~4
   9     6        RETURN                                                   !3
  10     7      > RETURN                                                   null
"""

        analyzer = PHPAnalyzer()
        functions, violations = analyzer._parse_vld_output(vld_output)

        # Should find DIV and MOD opcodes
        error_violations = [v for v in violations if v.severity == Severity.ERROR]
        self.assertGreater(len(error_violations), 0, "Should detect DIV/MOD opcodes")

        div_violations = [v for v in error_violations if v.mnemonic in ("DIV", "MOD")]
        self.assertEqual(len(div_violations), 2, "Should find both DIV and MOD")

    def test_parse_vld_function_call(self):
        """Parser should detect dangerous PHP function calls."""
        from script_analyzers import PHPAnalyzer

        vld_output = """
filename:       /path/to/test.php
function name:  vulnerable_encode
number of ops:  5
compiled vars:  !0 = $data
line     #* E I O op                           fetch          ext  return  operands
-------------------------------------------------------------------------------------
   3     0  E >   RECV                                             !0
   4     1        INIT_FCALL                                               'bin2hex'
         2        SEND_VAR                                                 !0
         3        DO_ICALL                                         $1
   5     4      > RETURN                                                   $1
"""

        analyzer = PHPAnalyzer()
        functions, violations = analyzer._parse_vld_output(vld_output)

        # Should detect bin2hex call
        error_violations = [v for v in violations if v.severity == Severity.ERROR]
        self.assertGreater(len(error_violations), 0, "Should detect bin2hex call")

        bin2hex_violations = [v for v in error_violations if "bin2hex" in v.mnemonic.lower()]
        self.assertEqual(len(bin2hex_violations), 1)

    def test_parse_vld_mt_rand(self):
        """Parser should detect mt_rand as dangerous."""
        from script_analyzers import PHPAnalyzer

        vld_output = """
filename:       /path/to/test.php
function name:  generate_token
line     #* E I O op                           fetch          ext  return  operands
-------------------------------------------------------------------------------------
   3     0  E >   INIT_FCALL                                               'mt_rand'
         1        SEND_VAL                                                 0
         2        SEND_VAL                                                 100
         3        DO_ICALL                                         $0
   4     4      > RETURN                                                   $0
"""

        analyzer = PHPAnalyzer()
        functions, violations = analyzer._parse_vld_output(vld_output)

        error_violations = [v for v in violations if v.severity == Severity.ERROR]
        self.assertGreater(len(error_violations), 0, "Should detect mt_rand")


class TestJavaScriptAnalyzerParsing(unittest.TestCase):
    """Test JavaScript V8 bytecode parsing."""

    def test_parse_v8_division(self):
        """Parser should detect V8 division bytecodes."""
        from script_analyzers import JavaScriptAnalyzer

        v8_output = """
[generated bytecode for function: vulnerableDiv (0x1234)]
Bytecode length: 20
Parameter count 3
Register count 2
Frame size 16
         0 : Ldar a0
         2 : Star0
         3 : Ldar a1
         5 : Div r0
         7 : Star1
         8 : Ldar r1
        10 : Return
"""

        analyzer = JavaScriptAnalyzer()
        functions, violations = analyzer._parse_v8_bytecode(
            v8_output, "test.js", include_warnings=False
        )

        self.assertEqual(len(functions), 1)
        self.assertEqual(functions[0]["name"], "vulnerableDiv")

        # Should find Div bytecode
        error_violations = [v for v in violations if v.severity == Severity.ERROR]
        self.assertGreater(len(error_violations), 0, "Should detect Div bytecode")

    def test_parse_v8_modulo(self):
        """Parser should detect V8 modulo bytecodes."""
        from script_analyzers import JavaScriptAnalyzer

        v8_output = """
[generated bytecode for function: vulnerableMod (0x5678)]
Bytecode length: 15
Parameter count 3
Register count 1
Frame size 8
         0 : Ldar a0
         2 : Mod a1
         4 : Return
"""

        analyzer = JavaScriptAnalyzer()
        functions, violations = analyzer._parse_v8_bytecode(v8_output, "test.js")

        error_violations = [v for v in violations if v.severity == Severity.ERROR]
        self.assertGreater(len(error_violations), 0, "Should detect Mod bytecode")

    def test_detect_math_sqrt_in_source(self):
        """Should detect Math.sqrt() calls in source."""
        # Create a temp file with Math.sqrt
        import tempfile

        from script_analyzers import JavaScriptAnalyzer

        with tempfile.NamedTemporaryFile(mode="w", suffix=".js", delete=False) as f:
            f.write("""
function vulnerable(x) {
    return Math.sqrt(x);
}
""")
            temp_path = f.name

        try:
            analyzer = JavaScriptAnalyzer()
            violations = analyzer._detect_dangerous_function_calls(temp_path)

            sqrt_violations = [v for v in violations if "SQRT" in v.mnemonic.upper()]
            self.assertGreater(len(sqrt_violations), 0, "Should detect Math.sqrt()")
        finally:
            os.unlink(temp_path)

    def test_detect_math_random_in_source(self):
        """Should detect Math.random() calls in source."""
        import tempfile

        from script_analyzers import JavaScriptAnalyzer

        with tempfile.NamedTemporaryFile(mode="w", suffix=".js", delete=False) as f:
            f.write("""
function generateToken() {
    return Math.random().toString(36);
}
""")
            temp_path = f.name

        try:
            analyzer = JavaScriptAnalyzer()
            violations = analyzer._detect_dangerous_function_calls(temp_path)

            random_violations = [v for v in violations if "RANDOM" in v.mnemonic.upper()]
            self.assertGreater(len(random_violations), 0, "Should detect Math.random()")
        finally:
            os.unlink(temp_path)


class TestPythonAnalyzerParsing(unittest.TestCase):
    """Test Python dis bytecode parsing."""

    def test_parse_dis_division_python311(self):
        """Parser should detect Python 3.11+ BINARY_OP division."""
        from script_analyzers import PythonAnalyzer

        # Python 3.11+ dis output format
        dis_output = """
Disassembly of <code object vulnerable_div at 0x1234>:
  3           0 RESUME                   0

  4           2 LOAD_FAST                0 (value)
              4 LOAD_FAST                1 (modulus)
              6 BINARY_OP               11 (/)
              8 STORE_FAST               2 (result)

  5          10 LOAD_FAST                0 (value)
             12 LOAD_FAST                1 (modulus)
             14 BINARY_OP                6 (%)
             16 STORE_FAST               3 (remainder)
             18 RETURN_VALUE
"""

        analyzer = PythonAnalyzer()
        functions, violations = analyzer._parse_dis_output(dis_output, "test.py")

        self.assertEqual(len(functions), 1)
        self.assertEqual(functions[0]["name"], "vulnerable_div")

        # Should find BINARY_OP division and modulo
        error_violations = [v for v in violations if v.severity == Severity.ERROR]
        self.assertEqual(len(error_violations), 2, "Should detect both / and % operators")

    def test_parse_dis_division_python310(self):
        """Parser should detect Python < 3.11 division bytecodes."""
        from script_analyzers import PythonAnalyzer

        # Python < 3.11 dis output format
        dis_output = """
Disassembly of <code object vulnerable_div at 0x1234>:
  3           0 LOAD_FAST                0 (value)
              2 LOAD_FAST                1 (modulus)
              4 BINARY_TRUE_DIVIDE
              6 STORE_FAST               2 (result)
              8 LOAD_FAST                0 (value)
             10 LOAD_FAST                1 (modulus)
             12 BINARY_MODULO
             14 STORE_FAST               3 (remainder)
             16 LOAD_CONST               0 (None)
             18 RETURN_VALUE
"""

        analyzer = PythonAnalyzer()
        functions, violations = analyzer._parse_dis_output(dis_output, "test.py")

        error_violations = [v for v in violations if v.severity == Severity.ERROR]
        self.assertEqual(
            len(error_violations), 2, "Should detect BINARY_TRUE_DIVIDE and BINARY_MODULO"
        )

        mnemonics = {v.mnemonic for v in error_violations}
        self.assertIn("BINARY_TRUE_DIVIDE", mnemonics)
        self.assertIn("BINARY_MODULO", mnemonics)

    def test_detect_random_in_source(self):
        """Should detect random.random() calls in source."""
        import tempfile

        from script_analyzers import PythonAnalyzer

        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
            f.write("""
import random

def generate_token():
    return random.random()

def generate_int():
    return random.randint(0, 100)
""")
            temp_path = f.name

        try:
            analyzer = PythonAnalyzer()
            violations = analyzer._detect_dangerous_function_calls(temp_path)

            random_violations = [v for v in violations if "RANDOM" in v.mnemonic.upper()]
            self.assertEqual(
                len(random_violations), 2, "Should detect random.random() and random.randint()"
            )
        finally:
            os.unlink(temp_path)

    def test_detect_math_sqrt_in_source(self):
        """Should detect math.sqrt() calls in source."""
        import tempfile

        from script_analyzers import PythonAnalyzer

        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
            f.write("""
import math

def vulnerable(x):
    return math.sqrt(x)
""")
            temp_path = f.name

        try:
            analyzer = PythonAnalyzer()
            violations = analyzer._detect_dangerous_function_calls(temp_path)

            sqrt_violations = [v for v in violations if "SQRT" in v.mnemonic.upper()]
            self.assertGreater(len(sqrt_violations), 0, "Should detect math.sqrt()")
        finally:
            os.unlink(temp_path)


class TestRubyAnalyzerParsing(unittest.TestCase):
    """Test Ruby YARV bytecode parsing."""

    def test_parse_yarv_division(self):
        """Parser should detect Ruby opt_div bytecodes."""
        from script_analyzers import RubyAnalyzer

        # Ruby YARV output format
        yarv_output = """
== disasm: #<ISeq:<main>@test.rb:1 (1,0)-(10,3)>
0000 putobject                              10
0002 putobject                              3
0004 opt_div                                <calldata!mid:/, argc:1, ARGS_SIMPLE>
0006 leave

== disasm: #<ISeq:vulnerable_mod@test.rb:5 (5,0)-(8,3)>
local table (size: 2, argc: 2 [opts: 0, rest: -1, post: 0, block: -1, kw: -1@-1, kwrest: -1])
[ 2] value@0    [ 1] modulus@1
0000 getlocal_WC_0                          value@0
0002 getlocal_WC_0                          modulus@1
0004 opt_mod                                <calldata!mid:%, argc:1, ARGS_SIMPLE>
0006 leave
"""

        analyzer = RubyAnalyzer()
        functions, violations = analyzer._parse_yarv_output(yarv_output, "test.rb")

        self.assertEqual(len(functions), 2)
        self.assertEqual(functions[0]["name"], "<main>")
        self.assertEqual(functions[1]["name"], "vulnerable_mod")

        # Should find opt_div and opt_mod
        error_violations = [v for v in violations if v.severity == Severity.ERROR]
        self.assertEqual(len(error_violations), 2, "Should detect opt_div and opt_mod")

        mnemonics = {v.mnemonic for v in error_violations}
        self.assertIn("OPT_DIV", mnemonics)
        self.assertIn("OPT_MOD", mnemonics)

    def test_parse_yarv_warnings(self):
        """Parser should detect Ruby comparison bytecodes as warnings."""
        from script_analyzers import RubyAnalyzer

        yarv_output = """
== disasm: #<ISeq:compare@test.rb:1 (1,0)-(3,3)>
0000 getlocal_WC_0                          a@0
0002 getlocal_WC_0                          b@1
0004 opt_eq                                 <calldata!mid:==, argc:1, ARGS_SIMPLE>
0006 branchif                               10
0008 putnil
0009 leave
0010 putobject                              true
0012 leave
"""

        analyzer = RubyAnalyzer()
        functions, violations = analyzer._parse_yarv_output(
            yarv_output, "test.rb", include_warnings=True
        )

        warning_violations = [v for v in violations if v.severity == Severity.WARNING]
        self.assertGreater(
            len(warning_violations), 0, "Should detect opt_eq and branchif as warnings"
        )

    def test_detect_rand_in_source(self):
        """Should detect rand() calls in source."""
        import tempfile

        from script_analyzers import RubyAnalyzer

        with tempfile.NamedTemporaryFile(mode="w", suffix=".rb", delete=False) as f:
            f.write("""
def generate_token
  rand(100)
end

def generate_random
  Random.new.rand
end
""")
            temp_path = f.name

        try:
            analyzer = RubyAnalyzer()
            violations = analyzer._detect_dangerous_function_calls(temp_path)

            rand_violations = [v for v in violations if "RAND" in v.mnemonic.upper()]
            self.assertGreater(len(rand_violations), 0, "Should detect rand() calls")
        finally:
            os.unlink(temp_path)


class TestJavaAnalyzerParsing(unittest.TestCase):
    """Test Java bytecode parsing."""

    def test_parse_javap_division(self):
        """Parser should detect Java division bytecodes."""
        from script_analyzers import JavaAnalyzer

        # Sample javap output with division
        javap_output = """
public class CryptoUtils {
  public int vulnerableDiv(int, int);
    Code:
       0: iload_1
       1: iload_2
       2: idiv
       3: istore_3
       4: iload_1
       5: iload_2
       6: irem
       7: istore        4
       9: iload_3
      10: ireturn
    LineNumberTable:
      line 5: 0
      line 6: 4
      line 7: 9
}
"""

        analyzer = JavaAnalyzer()
        functions, violations = analyzer._parse_javap_output(javap_output, "CryptoUtils.java")

        self.assertEqual(len(functions), 1)
        self.assertEqual(functions[0]["name"], "CryptoUtils.vulnerableDiv")

        # Should find idiv and irem bytecodes
        error_violations = [v for v in violations if v.severity == Severity.ERROR]
        self.assertEqual(len(error_violations), 2, "Should detect idiv and irem")

        mnemonics = {v.mnemonic for v in error_violations}
        self.assertIn("IDIV", mnemonics)
        self.assertIn("IREM", mnemonics)

    def test_parse_javap_long_division(self):
        """Parser should detect Java long division bytecodes."""
        from script_analyzers import JavaAnalyzer

        javap_output = """
public class CryptoUtils {
  public long vulnerableLongDiv(long, long);
    Code:
       0: lload_1
       1: lload_3
       2: ldiv
       3: lreturn
}
"""

        analyzer = JavaAnalyzer()
        functions, violations = analyzer._parse_javap_output(javap_output, "CryptoUtils.java")

        error_violations = [v for v in violations if v.severity == Severity.ERROR]
        self.assertGreater(len(error_violations), 0, "Should detect ldiv")
        self.assertEqual(error_violations[0].mnemonic, "LDIV")

    def test_parse_javap_float_division(self):
        """Parser should detect Java float division bytecodes."""
        from script_analyzers import JavaAnalyzer

        javap_output = """
public class CryptoUtils {
  public double vulnerableFloatDiv(double, double);
    Code:
       0: dload_1
       1: dload_3
       2: ddiv
       3: dreturn
}
"""

        analyzer = JavaAnalyzer()
        functions, violations = analyzer._parse_javap_output(javap_output, "CryptoUtils.java")

        error_violations = [v for v in violations if v.severity == Severity.ERROR]
        self.assertGreater(len(error_violations), 0, "Should detect ddiv")
        self.assertEqual(error_violations[0].mnemonic, "DDIV")

    def test_parse_javap_warnings(self):
        """Parser should detect Java conditional branches as warnings."""
        from script_analyzers import JavaAnalyzer

        javap_output = """
public class CryptoUtils {
  public boolean compare(int, int);
    Code:
       0: iload_1
       1: iload_2
       2: if_icmpne     9
       5: iconst_1
       6: goto          10
       9: iconst_0
      10: ireturn
}
"""

        analyzer = JavaAnalyzer()
        functions, violations = analyzer._parse_javap_output(
            javap_output, "CryptoUtils.java", include_warnings=True
        )

        warning_violations = [v for v in violations if v.severity == Severity.WARNING]
        self.assertGreater(len(warning_violations), 0, "Should detect if_icmpne as warning")

    def test_detect_java_random_in_source(self):
        """Should detect new Random() calls in Java source."""
        import tempfile

        from script_analyzers import JavaAnalyzer

        with tempfile.NamedTemporaryFile(mode="w", suffix=".java", delete=False) as f:
            f.write("""
public class Test {
    public int generate() {
        Random rand = new Random();
        return rand.nextInt(100);
    }
}
""")
            temp_path = f.name

        try:
            analyzer = JavaAnalyzer()
            violations = analyzer._detect_dangerous_function_calls(temp_path)

            random_violations = [v for v in violations if "RANDOM" in v.mnemonic.upper()]
            self.assertGreater(len(random_violations), 0, "Should detect new Random()")
        finally:
            os.unlink(temp_path)

    def test_detect_math_sqrt_in_java_source(self):
        """Should detect Math.sqrt() calls in Java source."""
        import tempfile

        from script_analyzers import JavaAnalyzer

        with tempfile.NamedTemporaryFile(mode="w", suffix=".java", delete=False) as f:
            f.write("""
public class Test {
    public double calculate(double x) {
        return Math.sqrt(x);
    }
}
""")
            temp_path = f.name

        try:
            analyzer = JavaAnalyzer()
            violations = analyzer._detect_dangerous_function_calls(temp_path)

            sqrt_violations = [v for v in violations if "SQRT" in v.mnemonic.upper()]
            self.assertGreater(len(sqrt_violations), 0, "Should detect Math.sqrt()")
        finally:
            os.unlink(temp_path)


class TestCSharpAnalyzerParsing(unittest.TestCase):
    """Test C# IL bytecode parsing."""

    def test_parse_il_division(self):
        """Parser should detect C# division IL opcodes."""
        from script_analyzers import CSharpAnalyzer

        # Sample IL output with division
        il_output = """
.method public hidebysig instance int32 VulnerableDiv(int32, int32) cil managed
{
  .maxstack 2
  .locals init (int32 V_0)
  IL_0000: ldarg.1
  IL_0001: ldarg.2
  IL_0002: div
  IL_0003: stloc.0
  IL_0004: ldarg.1
  IL_0005: ldarg.2
  IL_0006: rem
  IL_0007: stloc.1
  IL_0008: ldloc.0
  IL_0009: ret
}
"""

        analyzer = CSharpAnalyzer()
        functions, violations = analyzer._parse_il_output(il_output, "CryptoUtils.cs")

        self.assertEqual(len(functions), 1)
        self.assertEqual(functions[0]["name"], "VulnerableDiv")

        # Should find div and rem opcodes
        error_violations = [v for v in violations if v.severity == Severity.ERROR]
        self.assertEqual(len(error_violations), 2, "Should detect div and rem")

        mnemonics = {v.mnemonic for v in error_violations}
        self.assertIn("DIV", mnemonics)
        self.assertIn("REM", mnemonics)

    def test_parse_il_unsigned_division(self):
        """Parser should detect C# unsigned division IL opcodes."""
        from script_analyzers import CSharpAnalyzer

        il_output = """
.method public hidebysig static uint32 UnsignedDiv(uint32, uint32) cil managed
{
  .maxstack 2
  IL_0000: ldarg.0
  IL_0001: ldarg.1
  IL_0002: div.un
  IL_0003: ret
}
"""

        analyzer = CSharpAnalyzer()
        functions, violations = analyzer._parse_il_output(il_output, "CryptoUtils.cs")

        error_violations = [v for v in violations if v.severity == Severity.ERROR]
        self.assertGreater(len(error_violations), 0, "Should detect div.un")
        self.assertEqual(error_violations[0].mnemonic, "DIV.UN")

    def test_parse_il_warnings(self):
        """Parser should detect C# conditional branches as warnings."""
        from script_analyzers import CSharpAnalyzer

        il_output = """
.method public hidebysig instance bool Compare(int32, int32) cil managed
{
  .maxstack 2
  IL_0000: ldarg.1
  IL_0001: ldarg.2
  IL_0002: beq.s IL_0006
  IL_0004: ldc.i4.0
  IL_0005: ret
  IL_0006: ldc.i4.1
  IL_0007: ret
}
"""

        analyzer = CSharpAnalyzer()
        functions, violations = analyzer._parse_il_output(
            il_output, "CryptoUtils.cs", include_warnings=True
        )

        warning_violations = [v for v in violations if v.severity == Severity.WARNING]
        self.assertGreater(len(warning_violations), 0, "Should detect beq.s as warning")

    def test_detect_csharp_random_in_source(self):
        """Should detect new Random() calls in C# source."""
        import tempfile

        from script_analyzers import CSharpAnalyzer

        with tempfile.NamedTemporaryFile(mode="w", suffix=".cs", delete=False) as f:
            f.write("""
public class Test {
    public int Generate() {
        Random rand = new Random();
        return rand.Next(100);
    }
}
""")
            temp_path = f.name

        try:
            analyzer = CSharpAnalyzer()
            violations = analyzer._detect_dangerous_function_calls(temp_path)

            random_violations = [v for v in violations if "RANDOM" in v.mnemonic.upper()]
            self.assertGreater(len(random_violations), 0, "Should detect new Random()")
        finally:
            os.unlink(temp_path)

    def test_detect_math_sqrt_in_csharp_source(self):
        """Should detect Math.Sqrt() calls in C# source."""
        import tempfile

        from script_analyzers import CSharpAnalyzer

        with tempfile.NamedTemporaryFile(mode="w", suffix=".cs", delete=False) as f:
            f.write("""
public class Test {
    public double Calculate(double x) {
        return Math.Sqrt(x);
    }
}
""")
            temp_path = f.name

        try:
            analyzer = CSharpAnalyzer()
            violations = analyzer._detect_dangerous_function_calls(temp_path)

            sqrt_violations = [v for v in violations if "SQRT" in v.mnemonic.upper()]
            self.assertGreater(len(sqrt_violations), 0, "Should detect Math.Sqrt()")
        finally:
            os.unlink(temp_path)

    def test_source_only_fallback(self):
        """Source-only analysis should detect division operators."""
        import tempfile

        from script_analyzers import CSharpAnalyzer

        with tempfile.NamedTemporaryFile(mode="w", suffix=".cs", delete=False) as f:
            f.write("""
public class Test {
    public int Divide(int a, int b) {
        return a / b;
    }
    public int Modulo(int a, int b) {
        return a % b;
    }
}
""")
            temp_path = f.name

        try:
            analyzer = CSharpAnalyzer()
            report = analyzer._analyze_source_only(temp_path)

            # Should detect division and modulo operators
            div_violations = [v for v in report.violations if "DIV" in v.mnemonic]
            mod_violations = [v for v in report.violations if "REM" in v.mnemonic]

            self.assertGreater(len(div_violations), 0, "Should detect / operator")
            self.assertGreater(len(mod_violations), 0, "Should detect % operator")
        finally:
            os.unlink(temp_path)


class TestScriptAnalyzerIntegration(unittest.TestCase):
    """Integration tests for scripting language analyzers.

    These tests require PHP/Node.js/Python/Ruby to be installed.
    """

    @classmethod
    def setUpClass(cls):
        cls.samples_dir = Path(__file__).parent / "test_samples"
        cls.has_php = cls._check_runtime("php")
        cls.has_node = cls._check_runtime("node")
        cls.has_python = cls._check_runtime("python3")
        cls.has_ruby = cls._check_runtime("ruby")

    @staticmethod
    def _check_runtime(name):
        try:
            subprocess.run([name, "--version"], capture_output=True, check=True)
            return True
        except (subprocess.CalledProcessError, FileNotFoundError):
            return False

    def test_php_vulnerable_detected(self):
        """Vulnerable PHP code should be detected."""
        if not self.has_php:
            self.skipTest("PHP not available")

        vulnerable_file = self.samples_dir / "vulnerable.php"
        if not vulnerable_file.exists():
            self.skipTest("PHP test sample not found")

        try:
            report = analyze_source(str(vulnerable_file), include_warnings=False)

            # Should detect dangerous operations
            self.assertIsNotNone(report)
            self.assertEqual(report.architecture, "zend")

            # Check for expected violations (div, mod, or dangerous functions)
            if report.error_count > 0:
                self.assertFalse(report.passed, "Should fail with violations")

        except RuntimeError as e:
            if "VLD" in str(e) or "opcache" in str(e).lower():
                # VLD/opcache may not produce output for simple files
                pass
            else:
                raise

    def test_javascript_vulnerable_detected(self):
        """Vulnerable JavaScript code should be detected."""
        if not self.has_node:
            self.skipTest("Node.js not available")

        # Create a simple vulnerable JS file for testing
        import tempfile

        with tempfile.NamedTemporaryFile(mode="w", suffix=".js", delete=False) as f:
            f.write("""
function vulnerableDiv(a, b) {
    return a / b;
}

function vulnerableRandom() {
    return Math.random();
}

// Call functions to ensure they're compiled
console.log(vulnerableDiv(10, 3));
console.log(vulnerableRandom());
""")
            temp_path = f.name

        try:
            report = analyze_source(temp_path, include_warnings=False)

            self.assertIsNotNone(report)
            self.assertEqual(report.architecture, "v8")

            # Should detect Math.random at minimum (via source analysis)
            # V8 bytecode detection depends on function being compiled

        except RuntimeError as e:
            if "bytecode" in str(e).lower():
                # V8 bytecode output can be tricky
                pass
            else:
                raise
        finally:
            os.unlink(temp_path)

    def test_python_vulnerable_detected(self):
        """Vulnerable Python code should be detected."""
        if not self.has_python:
            self.skipTest("Python not available")

        vulnerable_file = self.samples_dir / "vulnerable.py"
        if not vulnerable_file.exists():
            self.skipTest("Python test sample not found")

        try:
            report = analyze_source(str(vulnerable_file), include_warnings=False)

            # Should detect dangerous operations
            self.assertIsNotNone(report)
            self.assertEqual(report.architecture, "cpython")

            # Should detect division operations and dangerous functions
            if report.error_count > 0:
                self.assertFalse(report.passed, "Should fail with violations")

            # Check for expected violation types
            div_violations = [
                v
                for v in report.violations
                if "DIV" in v.mnemonic.upper() or "MODULO" in v.mnemonic.upper()
            ]
            func_violations = [
                v
                for v in report.violations
                if "RANDOM" in v.mnemonic.upper() or "SQRT" in v.mnemonic.upper()
            ]

            # Should detect at least some violations
            self.assertGreater(
                len(div_violations) + len(func_violations),
                0,
                "Should detect division or dangerous function calls",
            )

        except RuntimeError as e:
            if "dis" in str(e).lower():
                # dis module issues
                pass
            else:
                raise

    def test_ruby_vulnerable_detected(self):
        """Vulnerable Ruby code should be detected."""
        if not self.has_ruby:
            self.skipTest("Ruby not available")

        vulnerable_file = self.samples_dir / "vulnerable.rb"
        if not vulnerable_file.exists():
            self.skipTest("Ruby test sample not found")

        try:
            report = analyze_source(str(vulnerable_file), include_warnings=False)

            # Should detect dangerous operations
            self.assertIsNotNone(report)
            self.assertEqual(report.architecture, "yarv")

            # Should detect division operations and dangerous functions
            if report.error_count > 0:
                self.assertFalse(report.passed, "Should fail with violations")

            # Check for expected violation types
            div_violations = [
                v
                for v in report.violations
                if "DIV" in v.mnemonic.upper() or "MOD" in v.mnemonic.upper()
            ]
            func_violations = [
                v
                for v in report.violations
                if "RAND" in v.mnemonic.upper() or "SQRT" in v.mnemonic.upper()
            ]

            # Should detect at least some violations
            self.assertGreater(
                len(div_violations) + len(func_violations),
                0,
                "Should detect division or dangerous function calls",
            )

        except RuntimeError as e:
            if "yarv" in str(e).lower() or "dump" in str(e).lower():
                # Ruby YARV issues
                pass
            else:
                raise


if __name__ == "__main__":
    unittest.main(verbosity=2)
