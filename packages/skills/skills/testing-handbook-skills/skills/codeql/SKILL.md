---
name: codeql
type: tool
description: >
  CodeQL is a static analysis framework that queries code as a database.
  Use when you need interprocedural analysis or complex data flow tracking.
---

# CodeQL

CodeQL is a powerful static analysis framework that allows developers and security researchers to query a codebase for specific code patterns. The CodeQL standard libraries implement support for both inter- and intraprocedural control flow and data flow analysis. However, the learning curve for writing custom queries is steep, and documentation for the CodeQL standard libraries is still scant.

## When to Use

**Use CodeQL when:**
- You need interprocedural control flow and data flow queries across the entire codebase
- Fine-grained control over the abstract syntax tree, control flow graph, and data flow graph is required
- You want to prevent introduction of known bugs and security vulnerabilities into the codebase
- You have access to source code and third-party dependencies (and can build compiled languages)
- The bug class requires complex analysis beyond single-file pattern matching

**Consider alternatives when:**
- Single-file pattern matching is sufficient → Consider Semgrep
- You don't have access to source code or can't build the project
- Analysis time is critical (complex queries may take a long time)
- You need to analyze a closed-source repository without a GitHub Advanced Security license
- The language is not supported by CodeQL

## Quick Reference

| Task | Command |
|------|---------|
| Create database (C/C++) | `codeql database create codeql.db --language=cpp --command='make -j8'` |
| Create database (Go) | `codeql database create codeql.db --language=go` |
| Create database (Java/Kotlin) | `codeql database create codeql.db --language=java` |
| Create database (JavaScript/TypeScript) | `codeql database create codeql.db --language=javascript` |
| Create database (Python) | `codeql database create codeql.db --language=python` |
| Analyze database | `codeql database analyze codeql.db --format=sarif-latest --output=results.sarif -- codeql/cpp-queries` |
| List installed packs | `codeql resolve qlpacks` |
| Download query pack | `codeql pack download trailofbits/cpp-queries` |
| Run custom query | `codeql query run --database codeql.db -- path/to/Query.ql` |
| Test custom queries | `codeql test run -- path/to/test/pack/` |

## Installation

### Installing CodeQL

CodeQL can be installed manually or via Homebrew on macOS/Linux.

**Manual Installation:**
Navigate to the [CodeQL release page](https://github.com/github/codeql-action/releases) and download the latest bundle for your architecture. The bundle contains the `codeql` binary, query libraries for supported languages, and pre-compiled queries.

**Using Homebrew:**
```bash
brew install --cask codeql
```

### Keeping CodeQL Up to Date

CodeQL is under active development. Update regularly to benefit from improvements.

**Manual installation:** Download new updates from the [CodeQL release page](https://github.com/github/codeql-action/releases).

**Homebrew installation:**
```bash
brew upgrade codeql
```

### Verification

```bash
codeql --version
```

## Core Workflow

### Step 1: Build a CodeQL Database

To build a CodeQL database, you typically need to be able to build the corresponding codebase. Ensure the codebase is in a clean state (e.g., run `make clean`, `go clean`, or similar).

**For compiled languages (C/C++, Swift):**
```bash
codeql database create codeql.db --language=cpp --command='make -j8'
```

If using CMake or out-of-source builds, add `--source-root` to specify the source file tree root:
```bash
codeql database create codeql.db --language=cpp --source-root=/path/to/source --command='cmake --build build'
```

**For interpreted languages (Python, JavaScript):**
```bash
codeql database create codeql.db --language=python
```

**For languages with auto-detection (Go, Java):**
```bash
codeql database create codeql.db --language=go
```

For complex build systems, use the `--command` argument to pass the build command.

### Step 2: Analyze the Database

Run pre-compiled query packs on the database:

```bash
codeql database analyze codeql.db --format=sarif-latest --output=results.sarif -- codeql/cpp-queries
```

Output formats include SARIF and CSV. SARIF results can be viewed with the [VSCode SARIF Explorer extension](https://marketplace.visualstudio.com/items?itemName=trailofbits.sarif-explorer).

### Step 3: Review Results

SARIF files contain findings with location, severity, and description. Import into your IDE or CI/CD pipeline for review and remediation.

### Installing Third-Party Query Packs

Published query packs are identified by scope/name/version. For example:

```bash
codeql pack download trailofbits/cpp-queries trailofbits/go-queries
```

For Trail of Bits public CodeQL queries, see [trailofbits/codeql-queries](https://github.com/trailofbits/codeql-queries).

## How to Customize

### Writing Custom Queries

CodeQL queries use a declarative, object-oriented language called QL with Java-like syntax and SQL-like query expressions.

**Basic query structure:**
```ql
import cpp

from FunctionCall call
where call.getTarget().getName() = "memcpy"
select call.getLocation(), call.getArgument(0)
```

This selects all expressions passed as the first argument to `memcpy`.

**Creating a custom class:**
```ql
import cpp

class MemcpyCall extends FunctionCall {
  MemcpyCall() {
    this.getTarget().getName() = "memcpy"
  }

  Expr getDestination() {
    result = this.getArgument(0)
  }

  Expr getSource() {
    result = this.getArgument(1)
  }

  Expr getSize() {
    result = this.getArgument(2)
  }
}

from MemcpyCall call
select call.getLocation(), call.getDestination()
```

### Key Syntax Reference

| Syntax/Operator | Description | Example |
|-----------------|-------------|---------|
| `from Type x where P(x) select f(x)` | Query: select f(x) for all x where P(x) is true | `from FunctionCall call where call.getTarget().getName() = "memcpy" select call` |
| `exists(...)` | Existential quantification | `exists(FunctionCall call \| call.getTarget() = fun)` |
| `forall(...)` | Universal quantification | `forall(Expr e \| e = arg.getAChild() \| e.isConstant())` |
| `+` | Transitive closure (1+ times) | `start.getASuccessor+()` |
| `*` | Reflexive transitive closure (0+ times) | `start.getASuccessor*()` |
| `result` | Special variable for method/function output | `result = this.getArgument(0)` |

### Example: Finding Unhandled Errors

```ql
import cpp

/**
 * @name Unhandled error return value
 * @id custom/unhandled-error
 * @description Function calls that return error codes that are not checked
 * @kind problem
 * @problem.severity warning
 * @precision medium
 */

predicate isErrorReturningFunction(Function f) {
  f.getName().matches("%error%") or
  f.getName().matches("%Error%")
}

from FunctionCall call
where
  isErrorReturningFunction(call.getTarget()) and
  not exists(Expr parent |
    parent = call.getParent*() and
    (parent instanceof IfStmt or parent instanceof SwitchStmt)
  )
select call, "Error return value not checked"
```

### Adding Query Metadata

Query metadata is defined in an initial comment:

```ql
/**
 * @name Short name for the issue
 * @id scope/query-name
 * @description Longer description of the issue
 * @kind problem
 * @tags security external/cwe/cwe-123
 * @problem.severity error
 * @precision high
 */
```

**Required fields:**
- `name`: Short string identifying the issue
- `id`: Unique identifier (lowercase letters, numbers, `/`, `-`)
- `description`: Longer description (a few sentences)
- `kind`: Either `problem` or `path-problem`
- `problem.severity`: `error`, `warning`, or `recommendation`
- `precision`: `low`, `medium`, `high`, or `very-high`

**Output format requirements:**
- `problem` queries: Output must be `(Location, string)`
- `path-problem` queries: Output must be `(DataFlow::Node, DataFlow::PathNode, DataFlow::PathNode, string)`

### Testing Custom Queries

Create a test pack with `qlpack.yml`:

```yaml
name: scope/name-test
version: 0.0.1
dependencies:
  codeql-query-pack-to-test: "*"
extractor: cpp
```

Create a test directory (e.g., `MemcpyCall/`) containing:
- `test.c`: Source file with code pattern to detect
- `MemcpyCall.qlref`: Text file with path to the query
- `MemcpyCall.expected`: Expected output

Run tests:
```bash
codeql test run -- path/to/test/pack/
```

If `MemcpyCall.expected` is missing or incorrect, an `MemcpyCall.actual` file is created. Review it, and if correct, rename to `MemcpyCall.expected`.

## Advanced Usage

### Creating New Query Packs

Initialize a query pack:
```bash
codeql pack init <scope>/<name>
```

This creates a `qlpack.yml` file:
```yaml
---
library: false
warnOnImplicitThis: false
name: <scope>/<name>
version: 0.0.1
```

Add standard library dependencies:
```bash
codeql pack add codeql/cpp-all
```

Create a workspace file (`codeql-workspace.yml`) for the CLI to work correctly.

Install dependencies:
```bash
codeql pack install
```

Configure the CLI to find your queries by creating `~/.config/codeql/config`:
```plain
--search-path /full/path/to/your/codeql/root/directory
```

### Recommended Directory Structure

```plain
.
├── codeql-workspace.yml
├── cpp
│   ├── lib
│   │   ├── qlpack.yml
│   │   └── scope
│   │       └── security
│   │           └── someLibrary.qll
│   ├── src
│   │   ├── qlpack.yml
│   │   ├── suites
│   │   │   ├── scope-cpp-code-scanning.qls
│   │   │   └── scope-cpp-security.qls
│   │   └── security
│   │       └── AppSecAnalysis
│   │           ├── AppSecAnalysis.c
│   │           ├── AppSecAnalysis.qhelp
│   │           └── AppSecAnalysis.ql
│   └── test
│       ├── qlpack.yml
│       └── query-tests
│           └── security
│               └── AppSecAnalysis
│                   ├── AppSecAnalysis.c
│                   ├── AppSecAnalysis.expected
│                   └── AppSecAnalysis.qlref
```

### Recursion and Transitive Closures

**Recursive predicate:**
```ql
predicate isReachableFrom(BasicBlock start, BasicBlock end) {
  start = end or isReachableFrom(start.getASuccessor(), end)
}
```

**Using transitive closure (equivalent):**
```ql
predicate isReachableFrom(BasicBlock start, BasicBlock end) {
  end = start.getASuccessor*()
}
```

Use `*` for zero or more applications, `+` for one or more.

### Excluding Individual Files

CodeQL instruments the build process. If object files already exist and are up-to-date, corresponding source files won't be added to the database. This can reduce database size but means CodeQL has only partial knowledge about excluded files and cannot reason about data flow through them.

**Recommendation:** Include third-party libraries and filter issues based on location rather than excluding files during database creation.

### Editor Support

**VSCode:** [CodeQL extension](https://marketplace.visualstudio.com/items?itemName=GitHub.vscode-codeql) provides LSP support, syntax highlighting, query running, and AST visualization.

**Neovim:** [codeql.nvim](https://github.com/pwntester/codeql.nvim) provides similar functionality.

**Helix/Other editors:** Use the CodeQL LSP server and [Tree-sitter grammar for CodeQL](https://github.com/tree-sitter/tree-sitter-ql).

**VSCode Quick Query:** Use "CodeQL: Quick Query" command to run single queries against a database.

**Debugging queries:** Add database source to workspace, then use "CodeQL: View AST" to display the AST for individual nodes.

## Configuration

### CodeQL Standard Libraries

CodeQL standard libraries are language-specific. Refer to API documentation:

- [C and C++](https://codeql.github.com/codeql-standard-libraries/cpp/)
- [Go](https://codeql.github.com/codeql-standard-libraries/go/)
- [Java and Kotlin](https://codeql.github.com/codeql-standard-libraries/java/)
- [JavaScript and TypeScript](https://codeql.github.com/codeql-standard-libraries/javascript/)
- [Python](https://codeql.github.com/codeql-standard-libraries/python/)
- [C#](https://codeql.github.com/codeql-standard-libraries/csharp/)
- [Ruby](https://codeql.github.com/codeql-standard-libraries/ruby/)
- [Swift](https://codeql.github.com/codeql-standard-libraries/swift/)

### Supported Languages

CodeQL supports C/C++, C#, Go, Java, Kotlin, JavaScript, TypeScript, Python, Ruby, and Swift. Check [supported languages and frameworks](https://codeql.github.com/docs/codeql-overview/supported-languages-and-frameworks) for details.

## CI/CD Integration

### GitHub Actions

Enable code scanning from "Code security and analysis" in repository settings. Choose default or advanced setup.

**Advanced setup workflow:**
```yaml
name: "CodeQL"

on:
  push:
    branches: [ "main" ]
  pull_request:
    branches: [ "main" ]
  schedule:
    - cron: '34 10 * * 6'

jobs:
  analyze:
    name: Analyze
    runs-on: ${{ (matrix.language == 'swift' && 'macos-latest') || 'ubuntu-latest' }}
    timeout-minutes: ${{ (matrix.language == 'swift' && 120) || 360 }}

    permissions:
      actions: read
      contents: read
      security-events: write

    strategy:
      fail-fast: false
      matrix:
        language: [ 'cpp' ]

    steps:
    - name: Checkout repository
      uses: actions/checkout@v4

    - name: Initialize CodeQL
      uses: github/codeql-action/init@v3
      with:
        languages: ${{ matrix.language }}

    - name: Autobuild
      uses: github/codeql-action/autobuild@v3

    - name: Perform CodeQL Analysis
      uses: github/codeql-action/analyze@v3
      with:
        category: "/language:${{matrix.language}}"
```

For compiled languages, replace autobuild with custom build commands:
```yaml
- run: |
    make -j8
```

### Using Custom Queries in CI

Specify query packs and queries in the "Initialize CodeQL" step:

```yaml
- uses: github/codeql-action/init@v3
  with:
    queries: security-extended,security-and-quality
    packs: trailofbits/cpp-queries
```

For repository-local queries:
```yaml
- uses: github/codeql-action/init@v3
  with:
    queries: ./codeql/UnhandledError.ql
    packs: trailofbits/cpp-queries
```

Note the `.` prefix for repository-relative paths. All queries must be part of a query pack with a `qlpack.yml` file.

### Testing Custom Queries in CI

```yaml
name: Test CodeQL queries

on: [push, pull_request]

jobs:
  codeql-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - id: init
        uses: github/codeql-action/init@v3
      - uses: actions/cache@v4
        with:
          path: ~/.codeql
          key: ${{ runner.os }}-${{ runner.arch }}-${{ steps.init.outputs.codeql-version }}
      - name: Run tests
        run: |
          ${{ steps.init.outputs.codeql-path }} test run ./path/to/query/tests/
```

This workflow caches query extraction and compilation for faster subsequent runs.

## Common Mistakes

| Mistake | Why It's Wrong | Correct Approach |
|---------|----------------|------------------|
| Not building project before creating database | CodeQL won't have complete information | Run `make clean` or equivalent, then build with CodeQL |
| Excluding third-party libraries from database | Prevents interprocedural analysis through library code | Include libraries, filter results by location |
| Using relative imports in query packs | Causes resolution issues | Use absolute imports from standard libraries |
| Not adding query metadata | SARIF output lacks severity, description | Always add metadata comment with required fields |
| Forgetting workspace file | CLI won't find query packs | Create `codeql-workspace.yml` in root directory |

## Limitations

- **Licensing:** Closed-source repositories require GitHub Enterprise or Advanced Security license
- **Build requirement:** Compiled languages must be buildable; no build = incomplete database
- **Performance:** Complex interprocedural queries can take a long time on large codebases
- **Language support:** Limited to CodeQL-supported languages and frameworks
- **Learning curve:** Steep learning curve for writing custom queries; documentation is scant
- **Single-language databases:** Each database is for one language; multi-language projects need multiple databases

## Related Skills

| Skill | When to Use Together |
|-------|---------------------|
| **semgrep** | Use Semgrep first for quick pattern-based analysis, then CodeQL for deeper interprocedural analysis |
| **sarif-parsing** | For processing CodeQL SARIF output in custom CI/CD pipelines |

## Resources

### Trail of Bits Blog Posts on CodeQL

- [Look out! Divergent representations are everywhere!](https://blog.trailofbits.com/2022/11/10/divergent-representations-variable-overflows-c-compiler/)
- [Finding unhandled errors using CodeQL](https://blog.trailofbits.com/2022/01/11/finding-unhandled-errors-using-codeql/)
- [Detecting iterator invalidation with CodeQL](https://blog.trailofbits.com/2020/10/09/detecting-iterator-invalidation-with-codeql/)

### Learning Resources

- [CodeQL zero to hero part 1: The fundamentals of static analysis for vulnerability research](https://github.blog/2023-03-31-codeql-zero-to-hero-part-1-the-fundamentals-of-static-analysis-for-vulnerability-research/)
- [QL language tutorials](https://codeql.github.com/docs/writing-codeql-queries/ql-tutorials/)
- [GitHub Security Lab CodeQL CTFs](https://securitylab.github.com/ctf/)

### Writing Custom CodeQL Queries

- [Practical introduction to CodeQL](https://jorgectf.github.io/blog/post/practical-codeql-introduction/)
- [Sharing security expertise through CodeQL packs (Part I)](https://github.blog/2022-04-19-sharing-security-expertise-through-codeql-packs-part-i/)

### Video Resources

- [Trail of Bits: Introduction to CodeQL - Examples, Tools and CI Integration](https://www.youtube.com/watch?v=rQRlnUQPXDw)
- [Finding Security Vulnerabilities in C/C++ with CodeQL](https://www.youtube.com/watch?v=eAjecQrfv3o)
- [Finding Security Vulnerabilities in JavaScript with CodeQL](https://www.youtube.com/watch?v=pYzfGaLTqC0)
- [Finding Security Vulnerabilities in Java with CodeQL](https://www.youtube.com/watch?v=nvCd0Ee4FgE)

### Using CodeQL for Vulnerability Discovery

- [Clang checkers and CodeQL queries for detecting untrusted pointer derefs and tainted loop conditions](https://www.zerodayinitiative.com/blog/2022/2/22/clang-checkers-and-codeql-queries-for-detecting-untrusted-pointer-derefs-and-tainted-loop-conditions)
- [Heap exploitation with CodeQL](https://github.com/google/security-research/blob/master/analysis/kernel/heap-exploitation/README.md)
- [Interesting kernel objects dashboard](https://lookerstudio.google.com/reporting/68b02863-4f5c-4d85-b3c1-992af89c855c/page/n92nD)

### CodeQL in CI/CD

- [Blue-teaming for Exiv2: adding custom CodeQL queries to code scanning](https://github.blog/2021-11-16-adding-custom-codeql-queries-code-scanning/)
- [Best practices on rolling out code scanning at enterprise scale](https://github.blog/2022-09-28-best-practices-on-rolling-out-code-scanning-at-enterprise-scale/)
- [Fine tuning CodeQL scans using query filters](https://colinsalmcorner.com/fine-tuning-codeql-scans/)
