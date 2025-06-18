# Project Structure Documentation Doesn't Match Actual Template

## ⚠️ Priority: High

## 📋 Issue Summary

The documented project structure in quickstart.md significantly understates what's actually created by `elizaos create`, missing important directories and files that developers need to understand.

## 🐛 Problem Description

### Documented Structure (Incorrect)
*File: `/packages/docs/docs/quickstart.md` lines 94-103*

```
my-project/
├── src/
│   └── index.ts      # Main entry point with character definitions
├── knowledge/        # Knowledge files for RAG
├── package.json      # Project configuration and dependencies
└── tsconfig.json     # TypeScript configuration
```

### Actual Template Structure
*Based on: `/packages/project-starter/`*

```
my-project/
├── src/
│   ├── index.ts      # Main entry point with character definitions
│   └── plugin.ts     # Starter plugin file (not documented)
├── scripts/
│   └── test-all.sh   # Test scripts (not documented)
├── __tests__/        # Comprehensive test suite (not documented)
│   ├── actions.test.ts
│   ├── character.test.ts
│   ├── config.test.ts
│   ├── env.test.ts
│   └── [12+ other test files]
├── cypress/          # E2E testing (not documented)
├── package.json      # Project configuration and dependencies
├── tsconfig.json     # TypeScript configuration
├── tsconfig.build.json # Build-specific TS config (not documented)
├── .env.example      # Environment template (not documented)
├── .gitignore        # Git ignore rules (not documented)
├── README.md         # Project documentation (not documented)
├── cypress.config.ts # E2E testing config (not documented)
├── index.html        # Frontend entry point (not documented)
├── postcss.config.js # CSS processing (not documented)
├── tailwind.config.js # Tailwind CSS (not documented)
├── tsup.config.ts    # Build configuration (not documented)
├── vite.config.ts    # Vite configuration (not documented)
└── vitest.config.ts  # Unit testing config (not documented)
```

### Key Issues

1. **Missing `knowledge/` directory**: Documented but not created by template
2. **Undocumented testing infrastructure**: Extensive test setup not mentioned
3. **Missing build/dev tools**: Modern toolchain completely undocumented
4. **Frontend capabilities**: HTML/CSS/JS setup not explained
5. **Plugin structure**: `plugin.ts` file not mentioned

## ✅ Acceptance Criteria

- [ ] Documentation shows complete and accurate project structure
- [ ] All major files and directories are explained
- [ ] Purpose of testing infrastructure is documented
- [ ] Build and development tools are explained
- [ ] Knowledge system usage is clarified (create directory or explain absence)

## 🔧 Implementation Steps

### 1. Update Project Structure Documentation

Replace the current structure in `/packages/docs/docs/quickstart.md` with:

```markdown
### Project Structure

A typical ElizaOS project structure looks like this:

```
my-project/
├── src/
│   ├── index.ts          # Main entry point with character definitions
│   └── plugin.ts         # Custom plugin implementation
├── __tests__/            # Comprehensive test suite
│   ├── actions.test.ts   # Action testing
│   ├── character.test.ts # Character validation
│   ├── integration.test.ts # Integration tests
│   └── [additional test files]
├── scripts/
│   └── test-all.sh       # Testing automation scripts
├── cypress/              # End-to-end testing configuration
├── knowledge/            # Knowledge files for RAG (create manually)
├── .env.example          # Environment variable template
├── package.json          # Project configuration and dependencies
├── tsconfig.json         # TypeScript configuration
├── tsconfig.build.json   # Build-specific TypeScript config
├── README.md             # Project documentation
├── cypress.config.ts     # E2E testing configuration
├── index.html            # Web interface entry point
├── tailwind.config.js    # Tailwind CSS configuration
├── tsup.config.ts        # Build tool configuration
├── vite.config.ts        # Development server configuration
└── vitest.config.ts      # Unit testing configuration
```
```

### 2. Add File Explanations

Add a section explaining key files:

```markdown
### Key Files Explained

- **`src/index.ts`**: Main character definition and agent configuration
- **`src/plugin.ts`**: Custom plugin template for extending functionality
- **`__tests__/`**: Comprehensive testing suite with unit and integration tests
- **`knowledge/`**: Directory for RAG knowledge files (create manually as needed)
- **`.env.example`**: Template for environment variables (copy to `.env`)
- **Build configs**: Modern toolchain with Vite, TypeScript, and Tailwind CSS
- **Testing configs**: Unit testing (Vitest) and E2E testing (Cypress)
```

### 3. Add Knowledge Directory Instructions

```markdown
### Setting Up Knowledge Files

The template doesn't create a `knowledge/` directory by default. To add RAG capabilities:

```bash
# Create knowledge directory
mkdir knowledge

# Add your documents
cp your-documents.pdf knowledge/
cp your-data.txt knowledge/

# Knowledge files are automatically indexed when the agent starts
```
```

### 4. Document Testing Infrastructure

```markdown
### Testing Your Project

The project template includes comprehensive testing:

```bash
# Run all tests
npm test

# Run unit tests only  
npm run test:unit

# Run E2E tests
npm run test:e2e

# Run tests in watch mode during development
npm run test:watch
```
```

## 📝 Files to Update

1. `/packages/docs/docs/quickstart.md` - Lines 94-105 (project structure section)
2. Consider adding `/packages/docs/docs/core/project-structure.md` for detailed reference

## 🧪 Testing

- [ ] Create a new project with `elizaos create`
- [ ] Verify actual structure matches updated documentation
- [ ] Test that all documented commands work
- [ ] Confirm knowledge directory creation instructions work

## 📚 Related Issues

- Issue #001: Node.js version conflicts need fixing first
- Issue #006: Command options need documentation
- Issue #010: Character file format needs standardization

## 💡 Additional Context

The current documentation significantly undersells the comprehensive nature of the ElizaOS project template. The actual template includes:

- **Modern development stack**: Vite, TypeScript, Tailwind CSS
- **Professional testing**: Unit tests, integration tests, E2E tests
- **Development tools**: Hot reloading, type checking, linting
- **Frontend capabilities**: Web interface components

This should be highlighted as a strength, not hidden from users.

## 📎 Source Code References

- Current docs: `/packages/docs/docs/quickstart.md:94-103`
- Actual template: `/packages/project-starter/`
- Template creation: `/packages/cli/src/commands/create/`