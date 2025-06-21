#!/usr/bin/env node

// Test script to verify loadProject behavior
import { loadProject } from '../cli/src/project.js';
import { logger } from '@elizaos/core';

async function test() {
  try {
    console.log('Testing loadProject with missing dist directory...');
    const project = await loadProject(process.cwd());
    console.log('Project loaded successfully:', project);
  } catch (error) {
    console.log('Expected error occurred:', error.message);
    if (error.message.includes('Module not found') && error.message.includes('Please build your project first')) {
      console.log('✅ SUCCESS: The error message is correct!');
    } else {
      console.log('❌ FAIL: Unexpected error message');
    }
  }
}

test(); 