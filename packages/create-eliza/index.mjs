#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'path';
import fs from 'fs';

const cliPath = (await import.meta.resolve('@elizaos/cli')).replace('file://', '');

// Display help message
function showHelp() {
  console.log(`Usage: elizaos create [options] [name]

Initialize a new project or plugin

Arguments:
  name               name for the project or plugin

Options:
  -d, --dir <dir>    installation directory (default: ".")
  -y, --yes          skip confirmation (default: false)
  -t, --type <type>  type of template to use (project or plugin) (default: "")
  -h, --help         display help for command`);
  process.exit(0);
}

// Get all command line arguments after the script name
const rawArgs = process.argv.slice(2);
let args = ['create'];

// Reserved keywords that aren't paths
const RESERVED_KEYWORDS = ['plugin', 'project', 'help'];

// If first argument is "help", show help and exit
if (rawArgs.length > 0 && rawArgs[0].toLowerCase() === 'help') {
  showHelp();
}

// Display welcome message with version for context
console.log(`
ElizaOS Project Creator
For help, run: npx elizaos create --help
`);

// Function to check if a string looks like a path or should be treated as one
const isLikelyPath = (str) => {
  // Obvious path indicators
  if (str.startsWith('./') || 
      str.startsWith('/') || 
      str.startsWith('../') || 
      str.includes('\\') || 
      str.includes('/') ||
      path.extname(str) !== '') {
    return true;
  }
  
  // Treat as a path if it's not a reserved keyword
  if (!RESERVED_KEYWORDS.includes(str.toLowerCase())) {
    return true;
  }
  
  return false;
};

// Special case: if only one argument and it looks like a path or directory name,
// it's likely meant to be a directory
if (rawArgs.length === 1 && isLikelyPath(rawArgs[0])) {
  args.push('-d', rawArgs[0]);
} 
// Handle case where npm passes positional args without flags
else if (rawArgs.length > 0 && !rawArgs[0].startsWith('-')) {
  // Check if the first arg might be a project type
  const possibleType = rawArgs[0];
  if (possibleType === 'plugin' || possibleType === 'project') {
    // Restructure as: create -t plugin my-plugin
    args.push('-t', possibleType);
    
    // If there's a second arg and it looks like a path, treat it as -d
    if (rawArgs.length > 1 && isLikelyPath(rawArgs[1])) {
      args.push('-d', rawArgs[1]);
      
      // Add any remaining arguments after the second
      if (rawArgs.length > 2) {
        args.push(...rawArgs.slice(2));
      }
    } 
    // Otherwise, just add the remaining args normally
    else if (rawArgs.length > 1) {
      args.push(...rawArgs.slice(1));
    }
  } else {
    // Not a known type, so assume it's a path and use -d
    args.push('-d', rawArgs[0]);
    
    // Add any remaining arguments
    if (rawArgs.length > 1) {
      args.push(...rawArgs.slice(1));
    }
  }
} else {
  // Process flagged arguments
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    
    // Handle directory flag
    if (arg === '-d' || arg === '--dir') {
      args.push(arg);
      if (i + 1 < rawArgs.length) {
        args.push(rawArgs[++i]);
      }
    }
    // Handle type flag
    else if (arg === '-t' || arg === '--type') {
      args.push(arg);
      if (i + 1 < rawArgs.length) {
        args.push(rawArgs[++i]);
      }
    }
    // Handle yes flag
    else if (arg === '-y' || arg === '--yes') {
      args.push(arg);
    }
    // Handle any other args
    else {
      args.push(arg);
    }
  }
}

// Spawn the CLI with restructured arguments
console.log(`Running: elizaos ${args.join(' ')}`);
spawn(cliPath, args, { stdio: 'inherit' });
