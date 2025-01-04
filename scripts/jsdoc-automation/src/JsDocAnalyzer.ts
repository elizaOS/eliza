import type { TSESTree } from '@typescript-eslint/types';
import { TypeScriptParser } from './TypeScriptParser.js';
import { ASTQueueItem, EnvUsage, TodoItem } from './types/index.js';
import { ASTQueueItem, EnvUsage, TodoItem } from './types/index.js';

type AST_NODE_TYPES = {
    ClassDeclaration: 'ClassDeclaration';
    FunctionDeclaration: 'FunctionDeclaration';
    TSTypeAliasDeclaration: 'TSTypeAliasDeclaration';
    TSEnumDeclaration: 'TSEnumDeclaration';
    MethodDefinition: 'MethodDefinition';
    TSMethodSignature: 'TSMethodSignature';
    TSInterfaceDeclaration: 'TSInterfaceDeclaration';
    TSPropertySignature: 'TSPropertySignature';
    ExportNamedDeclaration: 'ExportNamedDeclaration';
    Identifier: 'Identifier';
};

const AST_NODE_TYPES = {
    ClassDeclaration: 'ClassDeclaration',
    FunctionDeclaration: 'FunctionDeclaration',
    TSTypeAliasDeclaration: 'TSTypeAliasDeclaration',
    TSEnumDeclaration: 'TSEnumDeclaration',
    MethodDefinition: 'MethodDefinition',
    TSMethodSignature: 'TSMethodSignature',
    TSInterfaceDeclaration: 'TSInterfaceDeclaration',
    TSPropertySignature: 'TSPropertySignature',
    ExportNamedDeclaration: 'ExportNamedDeclaration',
    Identifier: 'Identifier',
} as const;

type DocumentableNodeType =
    | 'ClassDeclaration'
    | 'FunctionDeclaration'
    | 'TSTypeAliasDeclaration'
    | 'TSEnumDeclaration'
    | 'MethodDefinition'
    | 'TSMethodSignature'
    | 'TSInterfaceDeclaration'
    | 'TSPropertySignature';

interface Location {
    start: number;
    end: number;
}

/**
 * Class to analyze JSDoc comments in TypeScript code.
 */
export class JsDocAnalyzer {

    private documentableTypes: Set<DocumentableNodeType> = new Set([
        AST_NODE_TYPES.ClassDeclaration,
        AST_NODE_TYPES.FunctionDeclaration,
        AST_NODE_TYPES.TSTypeAliasDeclaration,
        AST_NODE_TYPES.TSEnumDeclaration,
        AST_NODE_TYPES.MethodDefinition,
        AST_NODE_TYPES.TSMethodSignature,
        AST_NODE_TYPES.TSPropertySignature,
        AST_NODE_TYPES.TSInterfaceDeclaration
    ]);

    /**
     * Type guard to check if a node is a ClassDeclaration
     */
    private isClassDeclaration(node: TSESTree.Node): node is TSESTree.ClassDeclaration {
        return node.type === AST_NODE_TYPES.ClassDeclaration;
    }

    /**
     * Type guard to check if a node is an InterfaceDeclaration
     */
    private isInterfaceDeclaration(node: TSESTree.Node): node is TSESTree.TSInterfaceDeclaration {
        return node.type === 'TSInterfaceDeclaration';  // Changed to match AST
    }

    /**
     * Type guard to check if a node is a MethodDefinition
     */
    private isMethodDefinition(node: TSESTree.Node): node is TSESTree.MethodDefinition {
        return node.type === AST_NODE_TYPES.MethodDefinition;
    }

    /**
     * Type guard for interface method signatures
     */
    private isMethodSignature(node: TSESTree.Node): node is TSESTree.TSMethodSignature {
        return node.type === AST_NODE_TYPES.TSMethodSignature;
    }

    /**
     * Type guard for interface property signatures
     */
    private isPropertySignature(node: TSESTree.Node): node is TSESTree.TSPropertySignature {
        return node.type === AST_NODE_TYPES.TSPropertySignature;
    }

    /**
     * Type guard for ExportNamedDeclaration nodes
     */
    private isExportNamedDeclaration(node: TSESTree.Node): node is TSESTree.ExportNamedDeclaration {
        return node.type === AST_NODE_TYPES.ExportNamedDeclaration;
    }

    /**
     * Type guard to check if a node is an Identifier
     * @param node - The node to check
     */
    private isIdentifier(node: TSESTree.Node): node is TSESTree.Identifier {
        return node.type === AST_NODE_TYPES.Identifier;
    }

    /**
     * Gets the actual node from either a regular node or an exported declaration
     * @param node - The AST node to process
     * @returns The actual declaration node
     */
    private getActualNode(node: TSESTree.Node): TSESTree.Node {
        if (this.isExportNamedDeclaration(node) && node.declaration) {
            return node.declaration;
        }
        return node;
    }

    /**
  * Gets the method name from a MethodDefinition node
  * @param node - The method definition node
  * @returns The method name or undefined
  */
    private getMethodName(node: TSESTree.MethodDefinition): string | undefined {
        if (this.isIdentifier(node.key)) {
            return node.key.name;
        }
        return undefined;
    }

    /**
     * Gets the name of a node if available
     */
    private getNodeName(node: TSESTree.Node): string | undefined {
        const actualNode = this.getActualNode(node);

        if (this.isMethodDefinition(actualNode)) {
            return this.getMethodName(actualNode);
        }

        if (this.isMethodSignature(actualNode) || this.isPropertySignature(actualNode)) {
            return this.isIdentifier(actualNode.key) ? actualNode.key.name : undefined;
        }

        if ('id' in actualNode && actualNode.id && this.isIdentifier(actualNode.id)) {
            return actualNode.id.name;
        }

        return undefined;
    }


    public missingJsDocNodes: TSESTree.Node[] = [];
    public todoItems: TodoItem[] = [];
    public envUsages: EnvUsage[] = [];

    /**
     * Constructor for initializing a new instance.
     * @param {TypeScriptParser} typeScriptParser - An instance of TypeScriptParser used for parsing TypeScript code.
     */
    constructor(
        public typeScriptParser: TypeScriptParser,
    ) { }



    /**
     * Analyzes the Abstract Syntax Tree (AST) of a program.
     * @param {TSESTree.Program} ast - The AST of the program to analyze.
     * @returns {void}
     */
    public analyze(ast: TSESTree.Program): void {
        this.traverse(ast, ast.comments || []);
    }

    /**
     * Traverses the AST node and checks for JSDoc comments.
     *
     * @param {TSESTree.Node} node - The AST node to traverse.
     * @param {TSESTree.Comment[]} [comments] - Optional array of comments associated with the node.
     */
    private traverse(node: TSESTree.Node, comments?: TSESTree.Comment[]): void {
        if (this.shouldHaveJSDoc(node)) {
            const jsDocComment = this.getJSDocComment(node, comments || []);
            if (!jsDocComment) {
                this.missingJsDocNodes.push(node);
            }
        }

        // Handle specific node types that can have children
        if ('body' in node) {
            const body = Array.isArray(node.body) ? node.body : [node.body];
            body.forEach(child => {
                if (child && typeof child === 'object') {
                    this.traverse(child as TSESTree.Node, comments);
                }
            });
        }

        // Handle other common child properties
        ['consequent', 'alternate', 'init', 'test', 'update'].forEach(prop => {
            if (prop in node && node[prop as keyof TSESTree.Node]) {
                this.traverse(node[prop as keyof TSESTree.Node] as TSESTree.Node, comments);
            }
        });
    }

    /**
     * Checks if a node should have JSDoc comments
     * @param node - The node to check
     * @returns True if the node should have JSDoc
     */
    public shouldHaveJSDoc(node: TSESTree.Node): boolean {
        const actualNode = this.getActualNode(node);
        return this.documentableTypes.has(actualNode.type as DocumentableNodeType);
    }

    /**
    * Gets any child nodes that should be processed for JSDoc
    * @param node - The parent node
    * @returns Array of child nodes that need JSDoc
    */
    public getDocumentableChildren(node: TSESTree.Node): TSESTree.Node[] {
        const actualNode = this.getActualNode(node);

        if (this.isClassDeclaration(actualNode)) {
            return actualNode.body.body.filter(this.isMethodDefinition);
        }

        // For interfaces, return empty array since we only want to document the interface itself
        if (this.isInterfaceDeclaration(actualNode)) {
            return []; // Don't process interface members
        }

        return [];
    }

    /**
     * Creates a queue item from a node
     */
    public createQueueItem(node: TSESTree.Node, filePath: string, code: string): ASTQueueItem {
        const actualNode = this.getActualNode(node);
        const nodeName = this.getNodeName(node);
        const parentInterface = this.isMethodSignature(actualNode) || this.isPropertySignature(actualNode)
            ? this.getParentInterfaceName(node)
            : undefined;
        const parentClass = this.isMethodDefinition(actualNode)
            ? this.getParentClassName(node)
            : undefined;

        return {
            filePath,
            startLine: node.loc?.start.line || 0,
            endLine: node.loc?.end.line || 0,
            nodeType: actualNode.type,
            className: parentClass || parentInterface,
            methodName: (this.isMethodDefinition(actualNode) || this.isMethodSignature(actualNode) || this.isPropertySignature(actualNode))
                ? nodeName
                : undefined,
            name: nodeName!,
            code: code,
        };
    }

    /**
     * Gets the parent class name for a method definition
     * @param node - The method node
     * @returns The parent class name or undefined
     */
    private getParentClassName(node: TSESTree.Node): string | undefined {
        let current = node.parent;
        while (current) {
            const actualNode = this.getActualNode(current);
            if (this.isClassDeclaration(actualNode) && this.isIdentifier(actualNode.id!)) {
                return actualNode.id.name;
            }
            current = current.parent;
        }
        return undefined;
    }

    /**
     * Gets the parent interface name for a method or property signature
     */
    private getParentInterfaceName(node: TSESTree.Node): string | undefined {
        let current = node.parent;
        while (current) {
            const actualNode = this.getActualNode(current);
            if (this.isInterfaceDeclaration(actualNode) && this.isIdentifier(actualNode.id)) {
                return actualNode.id.name;
            }
            current = current.parent;
        }
        return undefined;
    }



    /**
     * Check if the given node is a class node.
     *
     * @param {TSESTree.Node} node - The node to check
     * @returns {boolean} Returns true if the node is a class node, false otherwise
     */
    public isClassNode(node: TSESTree.Node): boolean {
        if (node.type === 'ClassDeclaration') {
            return true;
        }

        if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'ClassDeclaration') {
            return true;
        }

        return false;
    }

    /**
     * Retrieves the JSDoc comment associated with the given node if properly formatted.
     * @param node - The node to check for JSDoc comments
     * @param comments - Array of comments to search through
     * @returns The JSDoc comment if found and properly spaced, undefined otherwise
     */
    public getJSDocComment(node: TSESTree.Node, comments: TSESTree.Comment[]): string | undefined {
        if (!this.shouldHaveJSDoc(node)) {
            return undefined;
        }

        const functionStartLine = node.loc?.start.line;

        return comments.find((comment) => {
            const commentEndLine = comment.loc?.end.line;

            // Must be a block comment starting with * (JSDoc style)
            const isJSDocStyle = comment.type === 'Block' && comment.value.startsWith('*');

            // Check if the comment is right before the node (no 1-2 line gaps)
            const properSpacing = commentEndLine && functionStartLine &&
                (functionStartLine - commentEndLine > 2);

            return isJSDocStyle && properSpacing;
        })?.value;
    }

    /**
     * Returns the start and end location of the given Node.
     *
     * @param {TSESTree.Node} node - The Node to get location from.
     * @returns {Location} The start and end location of the Node.
     */
    public getNodeLocation(node: TSESTree.Node): Location {
        return {
            start: node.loc.start.line,
            end: node.loc.end.line,
        };
    }

    /**
     * Retrieves all methods of a specific class or all classes in a given file.
     * @param filePath - The path of the file to parse.
     * @param className - The name of the class to retrieve methods from. Optional.
     * @returns An array of MethodDefinition nodes representing the methods found.
     */
    public getClassMethods(filePath: string, className?: string): TSESTree.MethodDefinition[] {
        const ast = this.typeScriptParser.parse(filePath);
        if (!ast) return [];

        // Find all class declarations in the file
        const classNodes = ast.body.filter(
            (node: TSESTree.Node): node is TSESTree.ClassDeclaration =>
                node.type === 'ClassDeclaration' &&
                // If className is provided, match it, otherwise accept any class
                (className ? node.id?.name === className : true)
        );

        // Collect methods from all matching classes
        const methods: TSESTree.MethodDefinition[] = [];
        for (const classNode of classNodes) {
            const classMethods = classNode.body.body.filter(
                (node: TSESTree.Node): node is TSESTree.MethodDefinition =>
                    node.type === 'MethodDefinition'
            );
            methods.push(...classMethods);
        }

        return methods;
    }


  /**
     * Finds TODO comments in the code and their associated nodes
     * @param ast - The AST to analyze
     * @param comments - Array of comments to search through
     * @param sourceCode - The original source code
     */
  public findTodoComments(ast: TSESTree.Program, comments: TSESTree.Comment[], sourceCode: string): void {
    this.todoItems = [];

    comments.forEach(comment => {
        if (!comment.loc) return;

        const commentText = comment.value.toLowerCase();
        if (commentText.includes('todo')) {
            try {
                // Find the nearest node after the comment
                const nearestNode = this.findNearestNode(ast, comment.loc.end.line);
                if (nearestNode && nearestNode.loc) {
                    // Find the containing function/class/block
                    const containingBlock = this.findContainingBlock(nearestNode);

                    // Extract the actual code associated with the TODO
                    const code = this.extractNodeCode(sourceCode, nearestNode);

                    // Extract the full context (entire function/class/block)
                    const fullContext = containingBlock && containingBlock.loc
                        ? this.extractNodeCode(sourceCode, containingBlock)
                        : code;

                    this.todoItems.push({
                        comment: comment.value.trim(),
                        code,
                        fullContext,
                        node: nearestNode,
                        location: comment.loc,
                        contextLocation: containingBlock?.loc || comment.loc
                    });
                }
            } catch (error) {
                console.error('Error processing TODO comment:', error);
                // Continue processing other comments even if one fails
            }
        }
    });
}

/**
 * Finds the containing block (function/class/interface declaration) for a node
 */
private findContainingBlock(node: TSESTree.Node): TSESTree.Node | undefined {
    let current = node;
    while (current.parent) {
        if (
            current.parent.type === 'FunctionDeclaration' ||
            current.parent.type === 'ClassDeclaration' ||
            current.parent.type === 'TSInterfaceDeclaration' ||
            current.parent.type === 'MethodDefinition' ||
            current.parent.type === 'ArrowFunctionExpression' ||
            current.parent.type === 'FunctionExpression'
        ) {
            return current.parent;
        }
        current = current.parent;
    }
    return undefined;
}

/**
 * Finds environment variable usage in the code
 * @param ast - The AST to analyze
 * @param sourceCode - The original source code
 */
public findEnvUsages(ast: TSESTree.Program, sourceCode: string): void {
    this.envUsages = [];

    const findEnvReferences = (node: TSESTree.Node) => {
        if (!node.loc) return;

        // Check for process.env
        if (
            node.type === 'MemberExpression' &&
            node.object.type === 'Identifier' &&
            node.object.name === 'process' &&
            node.property.type === 'Identifier' &&
            node.property.name === 'env'
        ) {
            // Get the parent statement/expression for context
            const contextNode = this.findParentStatement(node);
            // Get the containing function/block for full context
            const containingBlock = this.findContainingBlock(node);

            // Get just the process.env reference
            const code = this.extractNodeCode(sourceCode, node);

            // Get the full line by using the line number directly
            const lines = sourceCode.split('\n');
            const context = lines[node.loc.start.line - 1];

            // Get the entire function/block containing this env usage
            const fullContext = containingBlock ? this.extractFullContext(sourceCode, containingBlock) : context;

            this.envUsages.push({
                code,
                context,
                fullContext,
                node,
                location: node.loc,
                contextLocation: containingBlock?.loc || node.loc
            });
        }

        // Continue traversing
        Object.keys(node).forEach(key => {
            const child = node[key as keyof TSESTree.Node];
            if (child && typeof child === 'object') {
                if (Array.isArray(child)) {
                    child.forEach(item => {
                        if (item && typeof item === 'object') {
                            findEnvReferences(item as TSESTree.Node);
                        }
                    });
                } else {
                    findEnvReferences(child as TSESTree.Node);
                }
            }
        });
    };

    findEnvReferences(ast);
}

/**
 * Extracts the actual source code for a given node
 */
private extractNodeCode(sourceCode: string, node: TSESTree.Node): string {
    if (!node.loc) {
        return '';
    }

    const lines = sourceCode.split('\n');
    const startLine = node.loc.start.line - 1;
    const endLine = node.loc.end.line;

    if (startLine < 0 || endLine > lines.length) {
        return '';
    }

    // Handle single-line case
    if (startLine === endLine - 1) {
        const line = lines[startLine];
        return line.slice(node.loc.start.column, node.loc.end.column);
    }

    // Handle multi-line case
    const result = [];
    for (let i = startLine; i < endLine; i++) {
        let line = lines[i];
        if (i === startLine) {
            line = line.slice(node.loc.start.column);
        } else if (i === endLine - 1) {
            line = line.slice(0, node.loc.end.column);
        }
        result.push(line);
    }
    return result.join('\n');
}

/**
 * Extracts the full context including any variable declarations and surrounding code
 */
private extractFullContext(sourceCode: string, node: TSESTree.Node): string {
    if (!node.loc) return '';

    const lines = sourceCode.split('\n');
    const startLine = node.loc.start.line - 1;
    const endLine = node.loc.end.line;

    if (startLine < 0 || endLine > lines.length) {
        return '';
    }

    // Get the complete lines for the entire block/function
    return lines.slice(startLine, endLine).join('\n');
}

/**
 * Finds the parent statement or expression node
 */
// prettyr sure this isnt needed, directly access code rather
private findParentStatement(node: TSESTree.Node): TSESTree.Node | undefined {
    let current = node;
    while (current.parent) {
        // Add more statement types that could contain process.env
        if (
            current.parent.type === 'VariableDeclaration' ||
            current.parent.type === 'ExpressionStatement' ||
            current.parent.type === 'AssignmentExpression' ||
            current.parent.type === 'ReturnStatement' ||
            current.parent.type === 'IfStatement' ||
            current.parent.type === 'LogicalExpression' ||
            current.parent.type === 'BinaryExpression' ||
            current.parent.type === 'Property' ||
            current.parent.type === 'ObjectExpression' ||
            current.parent.type === 'MemberExpression'
        ) {
            return current.parent;
        }
        // Add logging to see what types we're encountering
        console.log('Parent node type:', current.parent.type);
        current = current.parent;
    }
    return undefined;
}

/**
 * Finds the nearest node after a specific line number
 */
private findNearestNode(ast: TSESTree.Program, lineNumber: number): TSESTree.Node | undefined {
    let nearestNode: TSESTree.Node | undefined;
    let smallestDistance = Infinity;

    const traverse = (node: TSESTree.Node | null) => {
        if (!node) return;

        // Check if the node has a location
        if (node.loc) {
            const distance = node.loc.start.line - lineNumber;
            if (distance > 0 && distance < smallestDistance) {
                smallestDistance = distance;
                nearestNode = node;
            }
        }

        // Safely traverse child nodes
        if ('body' in node) {
            const body = Array.isArray(node.body) ? node.body : [node.body];
            body.forEach((child: TSESTree.Node) => {
                if (child && typeof child === 'object') {
                    traverse(child as TSESTree.Node);
                }
            });
        }

        // Handle specific node types
        if ('declarations' in node && Array.isArray(node.declarations)) {
            node.declarations.forEach((decl: TSESTree.Node) => traverse(decl));
        }

        if ('declaration' in node && node.declaration) {
            traverse(node.declaration);
        }

        // Handle other properties that might contain nodes
        ['consequent', 'alternate', 'init', 'test', 'update'].forEach(prop => {
            if (prop in node && node[prop as keyof typeof node]) {
                traverse(node[prop as keyof typeof node] as TSESTree.Node);
            }
        });
    };

    traverse(ast);
    return nearestNode;
}
}