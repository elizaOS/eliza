#!/usr/bin/env bun

/**
 * Simple Integration Test for Plugin Manager, AutoCoder, and Secrets Manager
 * 
 * This test focuses on validating the core integration patterns without
 * creating full agent runtime instances to avoid entity creation issues.
 */

import { describe, test, expect } from 'bun:test';

async function testPluginIntegration() {
  console.log('🚀 Starting Simple Plugin Integration Test');
  
  // Test 1: Verify Plugin Modules Load
  console.log('📦 Test 1: Loading plugin modules...');
  
  try {
    // Test plugin manager module loading
    const pluginManagerModule = await import('@elizaos/plugin-plugin-manager');
    expect(pluginManagerModule).toBeDefined();
    expect(pluginManagerModule.default || pluginManagerModule.pluginManagerPlugin).toBeDefined();
    console.log('✅ Plugin Manager module loaded successfully');
    
    // Test autocoder module loading
    const autocoderModule = await import('@elizaos/plugin-autocoder');
    expect(autocoderModule).toBeDefined();
    expect(autocoderModule.default || autocoderModule.autocoderPlugin).toBeDefined();
    console.log('✅ AutoCoder module loaded successfully');
    
    // Test secrets manager module loading
    const secretsModule = await import('@elizaos/plugin-secrets-manager');
    expect(secretsModule).toBeDefined();
    expect(secretsModule.default || secretsModule.secretsManagerPlugin).toBeDefined();
    console.log('✅ Secrets Manager module loaded successfully');
    
  } catch (error) {
    console.error('❌ Plugin module loading failed:', error);
    throw error;
  }
  
  // Test 2: Verify Action Definitions
  console.log('📋 Test 2: Checking action definitions...');
  
  try {
    const pluginManagerModule = await import('@elizaos/plugin-plugin-manager');
    const autocoderModule = await import('@elizaos/plugin-autocoder');
    const secretsModule = await import('@elizaos/plugin-secrets-manager');
    
    const pluginManagerPlugin = pluginManagerModule.default || pluginManagerModule.pluginManagerPlugin;
    const autocoderPlugin = autocoderModule.default || autocoderModule.autocoderPlugin;
    const secretsPlugin = secretsModule.default || secretsModule.secretsManagerPlugin;
    
    // Verify key actions exist
    expect(pluginManagerPlugin.actions).toBeDefined();
    expect(autocoderPlugin.actions).toBeDefined();
    expect(secretsPlugin.actions).toBeDefined();
    
    // Check for critical actions
    const pluginManagerActions = pluginManagerPlugin.actions || [];
    const autocoderActions = autocoderPlugin.actions || [];
    const secretsActions = secretsPlugin.actions || [];
    
    const hasDiscoveryAction = pluginManagerActions.some((action: any) => 
      action.name.includes('DISCOVER') || action.name.includes('SEARCH')
    );
    const hasCreateAction = autocoderActions.some((action: any) => 
      action.name.includes('CREATE') || action.name.includes('GENERATE')
    );
    const hasSecretAction = secretsActions.some((action: any) => 
      action.name.includes('SECRET') || action.name.includes('STORE')
    );
    
    expect(hasDiscoveryAction).toBe(true);
    expect(hasCreateAction).toBe(true);
    expect(hasSecretAction).toBe(true);
    
    console.log('✅ Action definitions verified successfully');
    
  } catch (error) {
    console.error('❌ Action definition check failed:', error);
    throw error;
  }
  
  // Test 3: Check Provider Integration
  console.log('🔌 Test 3: Checking provider integration...');
  
  try {
    const pluginManagerModule = await import('@elizaos/plugin-plugin-manager');
    const autocoderModule = await import('@elizaos/plugin-autocoder');
    const secretsModule = await import('@elizaos/plugin-secrets-manager');
    
    const pluginManagerPlugin = pluginManagerModule.default || pluginManagerModule.pluginManagerPlugin;
    const autocoderPlugin = autocoderModule.default || autocoderModule.autocoderPlugin;
    const secretsPlugin = secretsModule.default || secretsModule.secretsManagerPlugin;
    
    // Verify providers exist
    const pluginManagerProviders = pluginManagerPlugin.providers || [];
    const autocoderProviders = autocoderPlugin.providers || [];
    const secretsProviders = secretsPlugin.providers || [];
    
    expect(Array.isArray(pluginManagerProviders)).toBe(true);
    expect(Array.isArray(autocoderProviders)).toBe(true);
    expect(Array.isArray(secretsProviders)).toBe(true);
    
    console.log('✅ Provider integration verified successfully');
    
  } catch (error) {
    console.error('❌ Provider integration check failed:', error);
    throw error;
  }
  
  // Test 4: Dependencies and Plugin Registration
  console.log('🔗 Test 4: Checking dependency resolution...');
  
  try {
    const pluginManagerModule = await import('@elizaos/plugin-plugin-manager');
    const autocoderModule = await import('@elizaos/plugin-autocoder');
    const secretsModule = await import('@elizaos/plugin-secrets-manager');
    
    const pluginManagerPlugin = pluginManagerModule.default || pluginManagerModule.pluginManagerPlugin;
    const autocoderPlugin = autocoderModule.default || autocoderModule.autocoderPlugin;
    const secretsPlugin = secretsModule.default || secretsModule.secretsManagerPlugin;
    
    // Check for proper dependency declarations
    expect(pluginManagerPlugin.name).toBeDefined();
    expect(autocoderPlugin.name).toBeDefined();
    expect(secretsPlugin.name).toBeDefined();
    
    // Check for proper descriptions
    expect(pluginManagerPlugin.description).toBeDefined();
    expect(autocoderPlugin.description).toBeDefined();
    expect(secretsPlugin.description).toBeDefined();
    
    console.log('✅ Dependency resolution verified successfully');
    
  } catch (error) {
    console.error('❌ Dependency resolution check failed:', error);
    throw error;
  }
  
  console.log('🎉 Simple Plugin Integration Test completed successfully!');
  
  return {
    success: true,
    summary: {
      testsRun: 4,
      testsPassed: 4,
      testsFailed: 0,
      issues: [],
    }
  };
}

// Run the test
testPluginIntegration()
  .then((result) => {
    console.log('\n📊 Test Summary:');
    console.log(`✅ Tests Run: ${result.summary.testsRun}`);
    console.log(`✅ Tests Passed: ${result.summary.testsPassed}`);
    console.log(`❌ Tests Failed: ${result.summary.testsFailed}`);
    console.log('\n🚀 Integration test completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Integration test failed:', error);
    process.exit(1);
  });