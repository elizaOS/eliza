import type { TSESTree } from '@typescript-eslint/types';
import { TypeScriptParser } from './TypeScriptParser.js';
import { ASTQueueItem } from './types/index.js';

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
}