# Automated TypeScript Interface Extraction for Documentation

## 🔧 Priority: Low

## 📋 Issue Summary

Create automated tools to extract TypeScript interfaces, types, and function signatures from source code and generate/update documentation, preventing future documentation drift and reducing manual maintenance burden.

## 🐛 Problem Description

### Current Manual Process Issues

1. **Documentation Drift**: TypeScript interfaces change but documentation isn't updated
2. **Manual Effort**: Developers must manually copy interface definitions to docs
3. **Inconsistency**: Different documentation files show different versions of the same interface
4. **Error-Prone**: Manual copying introduces typos and omissions
5. **Maintenance Burden**: Every interface change requires documentation updates

### Examples of Drift

- Action interface in docs has `suppressInitialMessage` field that doesn't exist
- Handler callback signature differs between docs and implementation
- Service registration patterns shown incorrectly
- Missing optional fields in character interface documentation

## ✅ Acceptance Criteria

- [ ] Automated extraction of TypeScript interfaces from source code
- [ ] Generated documentation sections that stay synchronized with code
- [ ] CI/CD integration to detect documentation drift
- [ ] Template system for formatting extracted interfaces
- [ ] Support for JSDoc comments and type annotations
- [ ] Validation tools to ensure docs match implementation

## 🔧 Implementation Steps

### 1. Create TypeScript Interface Extractor

**Tool: `/scripts/extract-interfaces.js`**

```javascript
// scripts/extract-interfaces.js
// Purpose: Extract TypeScript interfaces and generate documentation

const ts = require('typescript');
const fs = require('fs');
const path = require('path');

class InterfaceExtractor {
  constructor(sourceDir, outputDir) {
    this.sourceDir = sourceDir;
    this.outputDir = outputDir;
    this.interfaces = new Map();
  }

  /**
   * Extract interfaces from TypeScript files
   */
  extractFromFile(filePath) {
    const sourceFile = ts.createSourceFile(
      filePath,
      fs.readFileSync(filePath, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );

    const interfaces = [];
    
    const visit = (node) => {
      if (ts.isInterfaceDeclaration(node)) {
        const interfaceInfo = {
          name: node.name.text,
          filePath: path.relative(this.sourceDir, filePath),
          members: this.extractMembers(node),
          jsdoc: this.extractJSDoc(node),
          exported: this.isExported(node),
        };
        interfaces.push(interfaceInfo);
      }
      
      if (ts.isTypeAliasDeclaration(node)) {
        const typeInfo = {
          name: node.name.text,
          filePath: path.relative(this.sourceDir, filePath),
          type: this.typeToString(node.type),
          jsdoc: this.extractJSDoc(node),
          exported: this.isExported(node),
        };
        interfaces.push(typeInfo);
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return interfaces;
  }

  /**
   * Extract interface members with types and documentation
   */
  extractMembers(interfaceNode) {
    return interfaceNode.members.map(member => {
      const memberInfo = {
        name: member.name?.text || 'unknown',
        type: this.typeToString(member.type),
        optional: !!member.questionToken,
        jsdoc: this.extractJSDoc(member),
      };

      return memberInfo;
    });
  }

  /**
   * Extract JSDoc comments
   */
  extractJSDoc(node) {
    const jsdocTags = ts.getJSDocTags(node);
    const description = ts.getTextOfJSDocComment(ts.getJSDocCommentsAndTags(node)[0]?.comment);
    
    return {
      description,
      tags: jsdocTags.map(tag => ({
        name: tag.tagName.text,
        comment: ts.getTextOfJSDocComment(tag.comment),
      })),
    };
  }

  /**
   * Convert TypeScript type to string representation
   */
  typeToString(typeNode) {
    if (!typeNode) return 'unknown';
    
    // Implementation details for different TypeScript type nodes
    // This would handle unions, intersections, arrays, etc.
    return typeNode.getText ? typeNode.getText() : 'unknown';
  }

  /**
   * Check if declaration is exported
   */
  isExported(node) {
    return node.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword) || false;
  }

  /**
   * Generate markdown documentation from extracted interfaces
   */
  generateMarkdown(interfaces) {
    let markdown = '# Generated Interface Documentation\n\n';
    markdown += '<!-- This file is auto-generated. Do not edit manually. -->\n\n';

    for (const iface of interfaces) {
      markdown += `## ${iface.name}\n\n`;
      
      if (iface.jsdoc?.description) {
        markdown += `${iface.jsdoc.description}\n\n`;
      }

      markdown += `**Source:** \`${iface.filePath}\`\n\n`;

      if (iface.members) {
        markdown += '```typescript\n';
        markdown += `interface ${iface.name} {\n`;
        
        for (const member of iface.members) {
          const optional = member.optional ? '?' : '';
          const description = member.jsdoc?.description ? ` // ${member.jsdoc.description}` : '';
          markdown += `  ${member.name}${optional}: ${member.type};${description}\n`;
        }
        
        markdown += '}\n';
        markdown += '```\n\n';
      } else if (iface.type) {
        markdown += '```typescript\n';
        markdown += `type ${iface.name} = ${iface.type};\n`;
        markdown += '```\n\n';
      }
    }

    return markdown;
  }

  /**
   * Process all TypeScript files in source directory
   */
  async processAll() {
    const tsFiles = this.findTypeScriptFiles(this.sourceDir);
    const allInterfaces = [];

    for (const file of tsFiles) {
      const interfaces = this.extractFromFile(file);
      allInterfaces.push(...interfaces);
    }

    // Group interfaces by category
    const coreInterfaces = allInterfaces.filter(i => i.filePath.includes('types/'));
    const componentInterfaces = allInterfaces.filter(i => i.filePath.includes('components'));
    
    // Generate documentation
    const coreMarkdown = this.generateMarkdown(coreInterfaces);
    const componentMarkdown = this.generateMarkdown(componentInterfaces);

    // Write to output files
    fs.writeFileSync(
      path.join(this.outputDir, 'generated-interfaces-core.md'),
      coreMarkdown
    );
    
    fs.writeFileSync(
      path.join(this.outputDir, 'generated-interfaces-components.md'),
      componentMarkdown
    );

    console.log(`Generated documentation for ${allInterfaces.length} interfaces`);
  }

  /**
   * Find all TypeScript files recursively
   */
  findTypeScriptFiles(dir) {
    const files = [];
    
    const walk = (currentDir) => {
      const items = fs.readdirSync(currentDir);
      
      for (const item of items) {
        const fullPath = path.join(currentDir, item);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory() && !item.startsWith('.')) {
          walk(fullPath);
        } else if (item.endsWith('.ts') && !item.endsWith('.d.ts')) {
          files.push(fullPath);
        }
      }
    };

    walk(dir);
    return files;
  }
}

// CLI usage
if (require.main === module) {
  const sourceDir = process.argv[2] || './packages/core/src';
  const outputDir = process.argv[3] || './packages/docs/docs/generated';

  const extractor = new InterfaceExtractor(sourceDir, outputDir);
  extractor.processAll().catch(console.error);
}

module.exports = InterfaceExtractor;
```

### 2. Create Documentation Template System

**Tool: `/scripts/doc-templates.js`**

```javascript
// scripts/doc-templates.js
// Purpose: Templates for generating consistent documentation

class DocumentationTemplates {
  /**
   * Generate action documentation template
   */
  static actionTemplate(interfaceData) {
    return `
## Action Interface

${interfaceData.description || 'Interface for ElizaOS actions'}

**Source Reference:** [\`${interfaceData.filePath}\`](https://github.com/elizaos/eliza/blob/main/${interfaceData.filePath})

\`\`\`typescript
${interfaceData.typescript}
\`\`\`

### Required Fields

${interfaceData.members.filter(m => !m.optional).map(m => 
  `- **\`${m.name}\`** (\`${m.type}\`): ${m.description || 'No description'}`
).join('\n')}

### Optional Fields

${interfaceData.members.filter(m => m.optional).map(m => 
  `- **\`${m.name}\`** (\`${m.type}\`): ${m.description || 'No description'}`
).join('\n')}

### Usage Example

\`\`\`typescript
import { Action } from '@elizaos/core';

const myAction: Action = {
  name: 'MY_ACTION',
  description: 'Description of what this action does',
  // ... implementation
};
\`\`\`
`;
  }

  /**
   * Generate service documentation template
   */
  static serviceTemplate(interfaceData) {
    return `
## Service Interface

${interfaceData.description || 'Interface for ElizaOS services'}

**Source Reference:** [\`${interfaceData.filePath}\`](https://github.com/elizaos/eliza/blob/main/${interfaceData.filePath})

\`\`\`typescript
${interfaceData.typescript}
\`\`\`

### Implementation Example

\`\`\`typescript
import { Service } from '@elizaos/core';

export class MyService extends Service {
  async initialize(): Promise<void> {
    // Initialization logic
  }

  async start(): Promise<void> {
    // Startup logic
  }

  async stop(): Promise<void> {
    // Cleanup logic
  }
}
\`\`\`
`;
  }
}

module.exports = DocumentationTemplates;
```

### 3. Create Validation Tools

**Tool: `/scripts/validate-docs.js`**

```javascript
// scripts/validate-docs.js
// Purpose: Validate that documentation matches implementation

const InterfaceExtractor = require('./extract-interfaces');
const fs = require('fs');
const path = require('path');

class DocumentationValidator {
  constructor(sourceDir, docsDir) {
    this.sourceDir = sourceDir;
    this.docsDir = docsDir;
    this.errors = [];
  }

  /**
   * Validate all documentation against source code
   */
  async validateAll() {
    const extractor = new InterfaceExtractor(this.sourceDir, this.docsDir);
    const actualInterfaces = await this.extractActualInterfaces(extractor);
    const documentedInterfaces = this.extractDocumentedInterfaces();

    this.validateInterfaceConsistency(actualInterfaces, documentedInterfaces);
    this.validateExampleCode();
    
    return this.errors;
  }

  /**
   * Extract interfaces from actual source code
   */
  async extractActualInterfaces(extractor) {
    const tsFiles = extractor.findTypeScriptFiles(this.sourceDir);
    const interfaces = new Map();

    for (const file of tsFiles) {
      const fileInterfaces = extractor.extractFromFile(file);
      for (const iface of fileInterfaces) {
        interfaces.set(iface.name, iface);
      }
    }

    return interfaces;
  }

  /**
   * Extract interfaces mentioned in documentation
   */
  extractDocumentedInterfaces() {
    const docFiles = this.findMarkdownFiles(this.docsDir);
    const interfaces = new Map();

    for (const file of docFiles) {
      const content = fs.readFileSync(file, 'utf8');
      const codeBlocks = this.extractTypeScriptBlocks(content);
      
      for (const block of codeBlocks) {
        const extractedInterfaces = this.parseInterfacesFromCode(block);
        for (const iface of extractedInterfaces) {
          interfaces.set(iface.name, { ...iface, documentedIn: file });
        }
      }
    }

    return interfaces;
  }

  /**
   * Validate interface consistency between source and docs
   */
  validateInterfaceConsistency(actual, documented) {
    for (const [name, actualInterface] of actual) {
      const documentedInterface = documented.get(name);
      
      if (!documentedInterface) {
        this.errors.push({
          type: 'missing-documentation',
          interface: name,
          message: `Interface ${name} exists in source but not documented`,
          file: actualInterface.filePath,
        });
        continue;
      }

      // Validate members
      this.validateMembers(name, actualInterface.members, documentedInterface.members);
    }

    // Check for documented interfaces that don't exist
    for (const [name, documentedInterface] of documented) {
      if (!actual.has(name)) {
        this.errors.push({
          type: 'outdated-documentation',
          interface: name,
          message: `Interface ${name} documented but doesn't exist in source`,
          file: documentedInterface.documentedIn,
        });
      }
    }
  }

  /**
   * Validate interface members match
   */
  validateMembers(interfaceName, actualMembers, documentedMembers) {
    const actualMemberMap = new Map(actualMembers.map(m => [m.name, m]));
    const documentedMemberMap = new Map(documentedMembers.map(m => [m.name, m]));

    // Check for missing members in documentation
    for (const [name, member] of actualMemberMap) {
      if (!documentedMemberMap.has(name)) {
        this.errors.push({
          type: 'missing-member-documentation',
          interface: interfaceName,
          member: name,
          message: `Member ${name} exists in source but not documented`,
        });
      }
    }

    // Check for members that don't exist
    for (const [name, member] of documentedMemberMap) {
      if (!actualMemberMap.has(name)) {
        this.errors.push({
          type: 'outdated-member-documentation',
          interface: interfaceName,
          member: name,
          message: `Member ${name} documented but doesn't exist in source`,
        });
      }
    }
  }

  /**
   * Validate code examples compile
   */
  validateExampleCode() {
    // Implementation to test that code examples actually compile
    // This would use TypeScript compiler API to validate examples
  }

  /**
   * Generate validation report
   */
  generateReport() {
    if (this.errors.length === 0) {
      return 'Documentation validation passed! All interfaces are synchronized.';
    }

    let report = `Documentation validation found ${this.errors.length} issues:\n\n`;

    const groupedErrors = this.groupErrorsByType();
    
    for (const [type, errors] of groupedErrors) {
      report += `## ${type.replace(/-/g, ' ').toUpperCase()}\n\n`;
      
      for (const error of errors) {
        report += `- **${error.interface}**`;
        if (error.member) report += `.${error.member}`;
        report += `: ${error.message}\n`;
        if (error.file) report += `  - File: ${error.file}\n`;
      }
      
      report += '\n';
    }

    return report;
  }

  groupErrorsByType() {
    const grouped = new Map();
    
    for (const error of this.errors) {
      if (!grouped.has(error.type)) {
        grouped.set(error.type, []);
      }
      grouped.get(error.type).push(error);
    }

    return grouped;
  }

  // Helper methods for parsing markdown and TypeScript...
  findMarkdownFiles(dir) {
    // Implementation to find all .md files
  }

  extractTypeScriptBlocks(content) {
    // Implementation to extract ```typescript code blocks
  }

  parseInterfacesFromCode(code) {
    // Implementation to parse interfaces from code strings
  }
}

// CLI usage
if (require.main === module) {
  const validator = new DocumentationValidator('./packages/core/src', './packages/docs/docs');
  
  validator.validateAll().then(errors => {
    const report = validator.generateReport();
    console.log(report);
    
    if (errors.length > 0) {
      process.exit(1);
    }
  });
}

module.exports = DocumentationValidator;
```

### 4. Integrate with CI/CD Pipeline

**CI Configuration: `.github/workflows/docs-validation.yml`**

```yaml
name: Documentation Validation

on:
  pull_request:
    paths:
      - 'packages/core/src/**/*.ts'
      - 'packages/docs/docs/**/*.md'
  push:
    branches: [main, develop]

jobs:
  validate-docs:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '23.3.0'
          
      - name: Install dependencies
        run: |
          npm install -g typescript
          npm install
          
      - name: Extract interfaces
        run: node scripts/extract-interfaces.js
        
      - name: Validate documentation
        run: node scripts/validate-docs.js
        
      - name: Check for documentation drift
        run: |
          if git diff --quiet; then
            echo "Documentation is synchronized"
          else
            echo "Documentation drift detected:"
            git diff
            exit 1
          fi
```

### 5. Add Package.json Scripts

```json
{
  "scripts": {
    "docs:extract": "node scripts/extract-interfaces.js",
    "docs:validate": "node scripts/validate-docs.js",
    "docs:sync": "npm run docs:extract && npm run docs:validate",
    "precommit": "npm run docs:validate"
  }
}
```

## 📝 Files to Create

### New Scripts
1. `/scripts/extract-interfaces.js` - TypeScript interface extraction
2. `/scripts/doc-templates.js` - Documentation templates
3. `/scripts/validate-docs.js` - Documentation validation
4. `/scripts/sync-docs.js` - Complete synchronization workflow

### CI/CD Configuration
1. `.github/workflows/docs-validation.yml` - GitHub Actions workflow
2. Update existing pre-commit hooks to include validation

### Documentation Updates
1. `/packages/docs/docs/contributing/documentation.md` - How to maintain docs
2. Update package.json with new scripts

## 🧪 Testing

- [ ] Test interface extraction on actual ElizaOS codebase
- [ ] Verify validation detects real inconsistencies
- [ ] Test CI/CD integration with sample PRs
- [ ] Confirm generated documentation is readable and accurate
- [ ] Validate that tools work across different TypeScript patterns

## 📚 Related Issues

- Issue #007: Action interface discrepancy (this would have caught it)
- Issue #017: Consistency validation (this provides the validation)
- Issue #020: CLI command automation (similar automation approach)

## 💡 Additional Context

### Benefits of Automated Interface Extraction

1. **Accuracy**: Documentation always matches implementation
2. **Efficiency**: Reduces manual documentation work
3. **Consistency**: Standardized formatting across all interface docs
4. **Maintenance**: Automated detection of documentation drift
5. **CI/CD Integration**: Prevents merging inconsistent documentation

### Implementation Challenges

1. **TypeScript Complexity**: Handling all TypeScript language features
2. **JSDoc Parsing**: Extracting meaningful documentation from comments
3. **Template Design**: Creating readable generated documentation
4. **Performance**: Processing large codebases efficiently
5. **Integration**: Working with existing documentation workflow

### Long-term Vision

This automation system could eventually:
- Auto-generate API documentation
- Validate code examples compile
- Generate migration guides between versions
- Create interactive documentation
- Support multiple output formats (JSON, YAML, etc.)

## 📎 Source Code References

- TypeScript interfaces: `/packages/core/src/types/`
- Current documentation: `/packages/docs/docs/core/`
- Build system: `/turbo.json`, `/package.json`
- CI configuration: `/.github/workflows/`