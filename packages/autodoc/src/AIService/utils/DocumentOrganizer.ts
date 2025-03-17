import type { ASTQueueItem } from '../../types';
import type { FileDocsGroup, OrganizedDocs } from '../types';

/**
 * Class representing a DocumentOrganizer.
 */

export class DocumentOrganizer {
  /**
   * Organizes the given array of ASTQueueItems into different categories based on their nodeType.
   * Categories include classes, methods, interfaces, types, functions, and variables.
   *
   * @param docs - The array of ASTQueueItems to be organized
   * @returns An object containing arrays of ASTQueueItems categorized by nodeType
   */
  public organizeDocumentation(docs: ASTQueueItem[]): OrganizedDocs {
    return docs.reduce(
      (acc: OrganizedDocs, doc) => {
        // Use nodeType to determine the category
        switch (doc.nodeType) {
          case 'ClassDeclaration':
            acc.classes.push(doc);
            break;
          case 'MethodDefinition':
          case 'TSMethodSignature':
            acc.methods.push(doc);
            break;
          case 'TSInterfaceDeclaration':
            acc.interfaces.push(doc);
            break;
          case 'TSTypeAliasDeclaration':
            acc.types.push(doc);
            break;
          case 'FunctionDeclaration':
            acc.functions.push(doc);
            break;
          case 'VariableDeclaration':
            acc.variables.push(doc);
            break;
        }
        return acc;
      },
      {
        classes: [],
        methods: [],
        interfaces: [],
        types: [],
        functions: [],
        variables: [],
      }
    );
  }

  /**
   * Groups the given organized documentation by file path.
   *
   * @param {OrganizedDocs} docs - The organized documentation to group.
   * @returns {FileDocsGroup[]} An array of grouped documentation based on file paths.
   */
  public groupDocsByFile(docs: OrganizedDocs): FileDocsGroup[] {
    // Get unique file paths
    const filePaths = new Set<string>();
    [
      ...docs.classes,
      ...docs.methods,
      ...docs.interfaces,
      ...docs.types,
      ...docs.functions,
      ...docs.variables,
    ].forEach((item) => filePaths.add(item.filePath));

    // Create groups for each file path
    return Array.from(filePaths).map((filePath) => {
      return {
        filePath,
        classes: docs.classes.filter((c) => c.filePath === filePath),
        methods: docs.methods.filter((m) => m.filePath === filePath),
        interfaces: docs.interfaces.filter((i) => i.filePath === filePath),
        types: docs.types.filter((t) => t.filePath === filePath),
        functions: docs.functions.filter((f) => f.filePath === filePath),
        variables: docs.variables.filter((v) => v.filePath === filePath),
      };
    });
  }
}
