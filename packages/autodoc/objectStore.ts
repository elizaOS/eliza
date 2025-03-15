import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Define the dictionary to track occurrences
const textDict: { [key: string]: number } = {};

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
function writeToObjectStore(content: string): string {
    const hash = generateHash(content);
    const dir = path.join(OBJECTS_DIR, hash.substring(0, 2));
    const filename = path.join(dir, hash.substring(2));

    //console.log(`DEBUG: ${hash}`);

    // Create directory if it doesn't exist
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // Only write if file doesn't exist
    if (!fs.existsSync(filename)) {
        fs.writeFileSync(filename, content);
        console.log(`Stored new text with hash: ${hash}`);
    } else  {
        //console.log(`Text with hash ${hash} already exists, skipping...`);
   }

    return hash;
}

export function processText(finalPrompt: string): void {
    const trimmedText = finalPrompt.trim();
    
    if (!trimmedText) {
        console.log("Empty text, skipping...");
        return;
    }

    if (textDict[trimmedText]) {
        // Text exists, increment count and report if it becomes a duplicate
        textDict[trimmedText]++;
        //if (textDict[trimmedText] === 2) {
            console.log("Duplicate text found:", trimmedText);
        //}
    } else {
        // New text, add to dictionary and store
        textDict[trimmedText] = 1;
        writeToObjectStore(trimmedText);
    }
}

