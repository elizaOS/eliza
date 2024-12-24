import * as fs from 'fs';
import * as path from 'path';

/**
 * Class representing a TypeScript file identifier.
 */
export class TypeScriptFileIdentifier {

    /**
     * Check if the given file is a TypeScript file based on its extension.
     * 
     * @param {string} file - The file to check.
     * @returns {boolean} Returns true if the file is a TypeScript file (.ts or .tsx), otherwise false.
     */
    public isTypeScriptFile(file: string): boolean {
        const extension = path.extname(file);
        return extension === '.ts' || extension === '.tsx';
    }

    /**
     * Retrieves an array of TypeScript files from the specified directory.
     * 
     * @param {string} directory - The directory path to search for TypeScript files.
     * @returns {string[]} - An array of TypeScript files found in the directory.
     */
    public getTypeScriptFiles(directory: string): string[] {
        const files = fs.readdirSync(directory);
        return files.filter((file) => this.isTypeScriptFile(file));
    }
}