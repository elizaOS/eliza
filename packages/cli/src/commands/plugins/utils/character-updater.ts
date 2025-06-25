import { logger, type Character } from '@elizaos/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadCharacterTryPath } from '@elizaos/server';
import * as ts from 'typescript';

/**
 * Represents a character file that can be updated
 */
export interface CharacterFile {
  path: string;
  format: 'json' | 'typescript';
  character: Character;
  content?: string;
}

/**
 * Load a character file and determine its format
 */
export async function loadCharacterFile(characterPath: string): Promise<CharacterFile> {
  const resolvedPath = path.resolve(characterPath);
  
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Character file not found: ${resolvedPath}`);
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  
  if (ext === '.json') {
    const character = await loadCharacterTryPath(resolvedPath);
    if (!character) {
      throw new Error(`Failed to load character from: ${resolvedPath}`);
    }
    return {
      path: resolvedPath,
      format: 'json',
      character,
      content: fs.readFileSync(resolvedPath, 'utf-8')
    };
  } else if (ext === '.ts' || ext === '.js') {
    // For TypeScript/JavaScript files, we need to parse and find the character export
    const character = await loadCharacterTryPath(resolvedPath);
    if (!character) {
      throw new Error(`Failed to load character from: ${resolvedPath}`);
    }
    return {
      path: resolvedPath,
      format: 'typescript',
      character,
      content: fs.readFileSync(resolvedPath, 'utf-8')
    };
  } else {
    throw new Error(`Unsupported character file format: ${ext}`);
  }
}

/**
 * Add a plugin to a character's plugins array
 */
export function addPluginToCharacter(character: Character, pluginName: string): Character {
  const plugins = character.plugins || [];
  
  // Check if plugin already exists
  if (plugins.includes(pluginName)) {
    logger.info(`Plugin '${pluginName}' is already in character '${character.name}'`);
    return character;
  }
  
  return {
    ...character,
    plugins: [...plugins, pluginName]
  };
}

/**
 * Remove a plugin from a character's plugins array
 */
export function removePluginFromCharacter(character: Character, pluginName: string): Character {
  const plugins = character.plugins || [];
  
  // Check if plugin exists
  if (!plugins.includes(pluginName)) {
    logger.info(`Plugin '${pluginName}' is not in character '${character.name}'`);
    return character;
  }
  
  return {
    ...character,
    plugins: plugins.filter(p => p !== pluginName)
  };
}

/**
 * Update a JSON character file
 */
export async function updateJsonCharacterFile(
  filePath: string, 
  character: Character
): Promise<void> {
  const content = JSON.stringify(character, null, 2);
  fs.writeFileSync(filePath, content, 'utf-8');
  logger.info(`Updated character file: ${filePath}`);
}

/**
 * Update a TypeScript character file
 */
export async function updateTypeScriptCharacterFile(
  filePath: string,
  originalContent: string,
  character: Character,
  pluginName: string,
  operation: 'add' | 'remove'
): Promise<void> {
  // Parse the TypeScript file
  const sourceFile = ts.createSourceFile(
    filePath,
    originalContent,
    ts.ScriptTarget.Latest,
    true
  );

  let updatedContent = originalContent;
  let found = false;

  // Find the plugins array in the character definition
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && 
        node.name && ts.isIdentifier(node.name) && 
        node.name.text === 'plugins' &&
        node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
      
      found = true;
      const pluginsArray = node.initializer;
      const start = pluginsArray.getStart();
      const end = pluginsArray.getEnd();
      
      if (operation === 'add') {
        // Check if plugin already exists
        const pluginExists = pluginsArray.elements.some(element => {
          if (ts.isStringLiteral(element)) {
            return element.text === pluginName;
          }
          return false;
        });

        if (!pluginExists) {
          // Add the plugin to the array
          const indent = '    '; // Adjust based on your formatting
          const newPlugin = `'${pluginName}'`;
          
          // Find the position to insert (before the closing bracket)
          const arrayContent = originalContent.substring(start, end);
          const lastElement = pluginsArray.elements[pluginsArray.elements.length - 1];
          
          if (lastElement) {
            const lastElementEnd = lastElement.getEnd();
            const beforeClosing = originalContent.substring(start, lastElementEnd);
            const afterClosing = originalContent.substring(lastElementEnd, end);
            
            // Add comma if needed
            const needsComma = !afterClosing.trim().startsWith(',');
            const insertion = needsComma ? `,\n${indent}${newPlugin}` : `\n${indent}${newPlugin}`;
            
            updatedContent = originalContent.substring(0, lastElementEnd) + 
                           insertion + 
                           originalContent.substring(lastElementEnd);
          } else {
            // Empty array
            const insertion = `\n${indent}${newPlugin}\n  `;
            updatedContent = originalContent.substring(0, start + 1) + 
                           insertion + 
                           originalContent.substring(start + 1);
          }
        }
      } else if (operation === 'remove') {
        // Remove the plugin from the array
        const elements = pluginsArray.elements;
        for (let i = 0; i < elements.length; i++) {
          const element = elements[i];
          if (ts.isStringLiteral(element) && element.text === pluginName) {
            const elementStart = element.getFullStart();
            const elementEnd = element.getEnd();
            
            // Check if we need to remove a comma
            let removeStart = elementStart;
            let removeEnd = elementEnd;
            
            // Look for comma after
            const afterElement = originalContent.substring(elementEnd);
            const commaMatch = afterElement.match(/^\s*,/);
            if (commaMatch) {
              removeEnd = elementEnd + commaMatch[0].length;
            } else if (i > 0) {
              // Look for comma before
              const beforeElement = originalContent.substring(0, elementStart);
              const lastCommaIndex = beforeElement.lastIndexOf(',');
              if (lastCommaIndex !== -1) {
                removeStart = lastCommaIndex;
              }
            }
            
            // Remove the element
            updatedContent = originalContent.substring(0, removeStart) + 
                           originalContent.substring(removeEnd);
            break;
          }
        }
      }
    }
    
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (!found) {
    logger.warn(`Could not find plugins array in TypeScript file: ${filePath}`);
    logger.info('You may need to manually update the character file.');
    return;
  }

  fs.writeFileSync(filePath, updatedContent, 'utf-8');
  logger.info(`Updated character file: ${filePath}`);
}

/**
 * Update a character file with a plugin change
 */
export async function updateCharacterFile(
  characterFile: CharacterFile,
  pluginName: string,
  operation: 'add' | 'remove'
): Promise<void> {
  const updatedCharacter = operation === 'add' 
    ? addPluginToCharacter(characterFile.character, pluginName)
    : removePluginFromCharacter(characterFile.character, pluginName);

  if (characterFile.format === 'json') {
    await updateJsonCharacterFile(characterFile.path, updatedCharacter);
  } else if (characterFile.format === 'typescript' && characterFile.content) {
    await updateTypeScriptCharacterFile(
      characterFile.path,
      characterFile.content,
      updatedCharacter,
      pluginName,
      operation
    );
  }
}

/**
 * Resolve character paths from various input formats
 */
export function resolveCharacterPaths(characterInput?: string | string[]): string[] {
  if (!characterInput) {
    return [];
  }

  const paths = Array.isArray(characterInput) ? characterInput : [characterInput];
  return paths.map(p => path.resolve(p));
} 