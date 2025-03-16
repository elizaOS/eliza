import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
/**
 * store queries to the llm in a git like directory
 */
// Directory for storing text objects
const OBJECTS_DIR = './text_objects';

// Ensure the objects directory exists
if (!fs.existsSync(OBJECTS_DIR)) {
    fs.mkdirSync(OBJECTS_DIR);
}

// Function to generate SHA-1 hash
function generateHash(content: string): string {
    return crypto.createHash('sha1')
        .update(content)
        .digest('hex');
}

// Function to write content to object store
function writeToObjectStore(content: string, output: string, hash:string): string {

    const dir = path.join(OBJECTS_DIR, hash.substring(0, 2));
    const filename = path.join(dir, hash.substring(2));

    // Create directory if it doesn't exist
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // Only write if file doesn't exist
    if (!fs.existsSync(filename)) {
        fs.writeFileSync(filename, content);
        console.log(`Stored new text with hash: ${hash}`);
    } else {
        console.log(`Skipped  hash: ${hash}`);
    }

    // always write the output
    fs.writeFileSync(filename + ".json", output);
        

    return hash;
}

export function processText(finalPrompt: string, result: string): void {
    const trimmedText = finalPrompt.trim();
    const hash = generateHash(trimmedText);
    console.log("DEBUG12:", hash);
    if (!trimmedText) {
        console.log("Empty text, skipping...");
        return;
    }

    writeToObjectStore(trimmedText, result, hash);
    console.log("New text found:", hash);
    
}

