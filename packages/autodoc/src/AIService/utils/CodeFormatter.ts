import type { FileDocsGroup } from '../types';

/**
 * Class representing a CodeFormatter that includes methods for formatting code components and JSDoc comments.
 */
export class CodeFormatter {
  /**
   * Ensures that the filePath has a .ts extension
   * @param {string} filePath - The file path to check/modify
   * @returns {string} The filePath with a .ts extension
   */
  public ensureTypeScriptExtension(filePath: string): string {
    // If the path already ends with .ts, return it as is
    if (filePath.endsWith('.ts')) {
      return filePath;
    }
    // Otherwise, append .ts
    return `${filePath}.ts`;
  }

  /**
   * Formats the API components in the given FileDocsGroup into a string.
   *
   * @param {FileDocsGroup} fileGroup - The FileDocsGroup containing the components to format.
   * @returns {string} The formatted API components string.
   */
  public formatApiComponents(fileGroup: FileDocsGroup): string {
    const sections: string[] = [];

    // Classes
    if (fileGroup.classes.length > 0) {
      sections.push('#### Classes');
      fileGroup.classes.forEach((c) => {
        sections.push(`##### \`${c.name}\``);
        if (c.jsDoc) sections.push(this.formatJSDoc(c.jsDoc, c.code));

        // Add any methods belonging to this class
        const classMethods = fileGroup.methods.filter((m) => m.className === c.name);
        if (classMethods.length > 0) {
          sections.push('**Methods:**');
          classMethods.forEach((m) => {
            sections.push(
              `###### \`${m.name}\`${m.jsDoc ? `\n${this.formatJSDoc(m.jsDoc, m.code)}` : ''}`
            );
          });
        }
      });
    }

    // Interfaces
    if (fileGroup.interfaces.length > 0) {
      sections.push('#### Interfaces');
      fileGroup.interfaces.forEach((i) => {
        sections.push(`##### \`${i.name}\``);
        if (i.jsDoc) sections.push(this.formatJSDoc(i.jsDoc, i.code));
      });
    }

    // Types
    if (fileGroup.types.length > 0) {
      sections.push('#### Types');
      fileGroup.types.forEach((t) => {
        sections.push(`##### \`${t.name}\``);
        if (t.jsDoc) sections.push(this.formatJSDoc(t.jsDoc, t.code));
      });
    }

    // Standalone Functions
    if (fileGroup.functions.length > 0) {
      sections.push('#### Functions');
      fileGroup.functions.forEach((f) => {
        sections.push(`##### \`${f.name}\``);
        if (f.jsDoc) sections.push(this.formatJSDoc(f.jsDoc, f.code));
      });
    }

    // Standalone Methods
    const standaloneMethods = fileGroup.methods.filter((m) => !m.className);
    if (standaloneMethods.length > 0) {
      sections.push('#### Methods');
      standaloneMethods.forEach((m) => {
        sections.push(`##### \`${m.name}\``);
        if (m.jsDoc) sections.push(this.formatJSDoc(m.jsDoc, m.code));
      });
    }

    return sections.join('\n\n');
  }

  /**
   * Formats the components in the given FileDocsGroup object into a string.
   *
   * @param {FileDocsGroup} fileGroup - The FileDocsGroup object containing classes, methods, interfaces, types, and functions.
   * @returns {string} The formatted string containing the components separated by sections.
   */
  public formatComponents(fileGroup: FileDocsGroup): string {
    const sections: string[] = [];

    if (fileGroup.classes.length > 0) {
      sections.push('Classes:', fileGroup.classes.map((c) => `- ${c.name}: ${c.jsDoc}`).join('\n'));
    }

    if (fileGroup.methods.length > 0) {
      sections.push('Methods:', fileGroup.methods.map((m) => `- ${m.name}: ${m.jsDoc}`).join('\n'));
    }

    if (fileGroup.interfaces.length > 0) {
      sections.push(
        'Interfaces:',
        fileGroup.interfaces.map((i) => `- ${i.name}: ${i.jsDoc}`).join('\n')
      );
    }

    if (fileGroup.types.length > 0) {
      sections.push('Types:', fileGroup.types.map((t) => `- ${t.name}: ${t.jsDoc}`).join('\n'));
    }

    if (fileGroup.functions.length > 0) {
      sections.push(
        'Functions:',
        fileGroup.functions.map((f) => `- ${f.name}: ${f.jsDoc}`).join('\n')
      );
    }

    return sections.join('\n\n');
  }

  /**
   * Formats a file path by getting the relative path from the 'src' directory.
   *
   * @param {string} filePath - The file path to be formatted.
   * @returns {string} The formatted relative path from the 'src' directory.
   */
  public formatFilePath(filePath: string): string {
    // Get relative path from src directory
    const srcIndex = filePath.indexOf('/src/');
    if (srcIndex === -1) return filePath;

    const relativePath = filePath.slice(srcIndex + 5); // +5 to skip '/src/'
    return relativePath;
  }

  /**
   * Formats the JSDoc comment by cleaning it up and adding TypeScript declaration.
   *
   * @param {string} jsDoc - The original JSDoc comment
   * @param {string} [_code] - Optional code snippet to include after the JSDoc
   * @returns {string} The formatted JSDoc comment
   */
  public formatJSDoc(jsDoc: string, _code?: string): string {
    // Clean up the JSDoc
    let cleanDoc = jsDoc.replace(/^```\s*\n?/gm, '').replace(/\n?```\s*$/gm, '');
    cleanDoc = cleanDoc.trim().replace(/\n{3,}/g, '\n\n');

    // Format JSDoc with typescript declaration
    const docSection = `\`\`\`typescript\n${cleanDoc}\n\`\`\``;

    // If we have the actual code, include it after the JSDoc
    // if (code) {
    //     const cleanCode = code.trim().replace(/^```\s*\n?/gm, '').replace(/\n?```\s*$/gm, '');
    //     return `${docSection}\n\n**Implementation:**\n\n\`\`\`typescript\n${cleanCode}\n\`\`\``;
    // }

    return docSection;
  }

  /**
   * Truncates a code block if its length exceeds the specified maximum length.
   *
   * @param {string} code - The code block to truncate.
   * @param {number} [maxLength=8000] - The maximum length of the code block before truncation.
   * @returns {string} The truncated code block.
   */
  public truncateCodeBlock(code: string, maxLength = 8000): string {
    if (code.length <= maxLength) return code;

    // Extract code blocks
    const codeBlockRegex = /```[\s\S]*?```/g;
    const codeBlocks = code.match(codeBlockRegex) || [];

    // If no code blocks found, truncate the text directly
    if (codeBlocks.length === 0) {
      return `${code.slice(0, maxLength)}... (truncated)`;
    }

    // Calculate maximum length per block to stay under total limit
    const nonCodeLength = code.replace(codeBlockRegex, '').length;
    const maxLengthPerBlock = Math.floor((maxLength - nonCodeLength) / codeBlocks.length);

    for (let i = 0; i < codeBlocks.length; i++) {
      const block = codeBlocks[i];
      if (block.length > maxLengthPerBlock) {
        const lines = block.split('\n');
        const header = lines[0]; // Keep the ```typescript or similar
        const footer = lines[lines.length - 1]; // Keep the closing ```

        // Calculate how many lines we can keep
        const maxLinesPerSection = Math.floor(
          (maxLengthPerBlock - header.length - footer.length) / 3
        );

        // Take fewer lines but ensure we get the most important parts
        const codeStart = lines.slice(1, maxLinesPerSection).join('\n');

        // For the middle section, focus on the important parts
        const middleIndex = Math.floor(lines.length / 2);
        const middleStart = Math.max(
          maxLinesPerSection,
          middleIndex - Math.floor(maxLinesPerSection / 2)
        );
        const middleEnd = Math.min(
          lines.length - maxLinesPerSection,
          middleIndex + Math.floor(maxLinesPerSection / 2)
        );
        const codeMiddle = lines.slice(middleStart, middleEnd).join('\n');

        // Take the end section
        const codeEnd = lines.slice(lines.length - maxLinesPerSection, -1).join('\n');

        const truncatedBlock = `${header}\n${codeStart}\n// ... truncated [${lines.length - maxLinesPerSection * 2} lines] ...\n${codeMiddle}\n// ... truncated ...\n${codeEnd}\n${footer}`;
        code = code.replace(block, truncatedBlock);
      }
    }

    // Final safety check - if still too long, do a hard truncate
    if (code.length > maxLength) {
      const blocks = code.split('```');
      const truncatedBlocks = blocks.map((block, index) => {
        // Every odd index is a code block
        if (index % 2 === 1) {
          const lines = block.split('\n');
          const maxLines = 10; // Keep only first few lines of each block
          return `${lines.slice(0, maxLines).join('\n')}\n// ... remaining code truncated ...\n`;
        }
        return block.slice(0, 500); // Limit non-code text
      });
      code = truncatedBlocks.join('```');
    }

    return code;
  }
}
