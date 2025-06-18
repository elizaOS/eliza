---
title: Automated Documentation
description: An overview of the tools and processes used to automatically generate and validate documentation from source code.
---

# Automated Documentation

To combat documentation drift and reduce manual effort, ElizaOS uses an automated system to extract information directly from the TypeScript source code and ensure the docs stay synchronized.

## The Problem: Documentation Drift

In a rapidly evolving project, it's easy for documentation to fall out of sync with the source code. This leads to:
- Incorrect examples.
- Documentation for features that no longer exist.
- Undocumented features.
- General developer confusion and a loss of trust in the documentation.

Our solution is a "docs-as-code" approach where the documentation is generated and validated from the single source of truth: the code itself.

## Automation Pipeline

Our documentation automation is a multi-stage process handled by custom scripts and integrated into our CI/CD pipeline.

```mermaid
graph TD
    A[TypeScript Source Code in `packages/core/src`] --> B{`docusaurus-plugin-typedoc`};
    B --> C[API Reference Docs in `docs/api`];

    A --> D{`Interface Extractor Script`};
    D --> E[Interface Data (JSON)];
    E --> F{`Docs Template System`};
    F --> G[Generated Markdown Files in `docs/generated`];
    
    A --> H{`Validation Script`};
    G --> H;
    H --> I{Validation Report};
    I --> J[CI/CD Check];
```

### 1. API Reference Generation (`TypeDoc`)

We use `docusaurus-plugin-typedoc` to automatically generate a full API reference from the JSDoc comments in our TypeScript files.

-   **Source**: JSDoc comments in the `packages/core/src` directory.
-   **Process**: The TypeDoc plugin parses the TypeScript code and comments during the Docusaurus build process.
-   **Output**: A browsable API reference available under the "API" section of the docs.
-   **Configuration**: See `docusaurus.config.ts`.

This ensures that every documented class, interface, type, and function in the API reference perfectly matches the source code.

### 2. Interface and Type Extraction (Custom Scripts)

For embedding code definitions directly into guide documents (like the one you're reading), we use a custom script to extract them.

-   **Tool**: `/scripts/extract-interfaces.js`
-   **Process**: This script uses the TypeScript compiler API to traverse the abstract syntax tree (AST) of our source files. It identifies exported interfaces and types, extracts their structure (members, types, optionality), and captures any associated JSDoc comments.
-   **Output**: The extracted information can then be formatted as Markdown or used by other tools.

### 3. Documentation Validation

To ensure that manually written documentation doesn't drift, a validation script runs in our CI pipeline.

-   **Tool**: `/scripts/validate-docs.js`
-   **Process**:
    1.  It extracts all interface and type definitions from the source code using the same mechanism as the extractor script.
    2.  It then parses all Markdown documentation files to find code blocks that define interfaces (e.g., `interface Action { ... }`).
    3.  It compares the two sets of definitions and flags any discrepancies:
        -   Members present in the source but not in the docs.
        -   Members present in the docs but not in the source.
        -   Mismatched types or optionality.
-   **Output**: A report of all inconsistencies. If any are found, the CI check fails, preventing the merge of pull requests that would cause documentation drift.

## How to Use the Tools

While these tools primarily run in CI, you can use them locally.

### Package.json Scripts
```json
{
  "scripts": {
    "docs:extract": "node scripts/extract-interfaces.js",
    "docs:validate": "node scripts/validate-docs.js"
  }
}
```

-   **`bun run docs:extract`**: Manually run the interface extractor. (Note: this is not yet fully integrated to auto-update docs, but is used by the validation script).
-   **`bun run docs:validate`**: Run the validation script locally to check your documentation changes for inconsistencies before you commit. This is highly recommended.

### CI/CD Integration

Our GitHub Actions workflow in `.github/workflows/docs-validation.yml` automatically runs the `docs:validate` script on every pull request that modifies source code (`.ts`) or documentation (`.md`) files. This acts as a safety net to ensure all documented interfaces are accurate before they get merged. 