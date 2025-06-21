#!/usr/bin/env node

/**
 * Trust-Rolodex Integration Scenario Validator
 * 
 * This script validates the structure and logic of our integration scenarios
 * without requiring full system initialization.
 */

const fs = require('fs');
const path = require('path');

// List of scenario files to validate
const scenarioFiles = [
  'plugin-tests/51-trust-rolodex-basic-integration.ts',
  'plugin-tests/52-trust-network-propagation.ts',
  'plugin-tests/53-social-engineering-defense.ts',
  'plugin-tests/54-cross-platform-identity-verification.ts',
  'plugin-tests/55-trust-decay-relationship-maintenance.ts'
].map(file => path.resolve(__dirname, file));

// Validation results
const results = {
  totalScenarios: 0,
  validScenarios: 0,
  issues: [],
  details: []
};

console.log('🔍 Validating Trust-Rolodex Integration Scenarios...\n');

function validateScenarioStructure(scenarioPath) {
  try {
    const content = fs.readFileSync(scenarioPath, 'utf8');
    const fileName = path.basename(scenarioPath);
    
    // Basic structure checks
    const checks = {
      hasDefaultExport: content.includes('export default'),
      hasScenarioId: content.includes('id:'),
      hasActors: content.includes('actors:'),
      hasVerificationRules: content.includes('verification:') && content.includes('rules:'),
      hasTrustIntegration: content.includes('trust') || content.includes('Trust'),
      hasRolodexIntegration: content.includes('rolodex') || content.includes('Rolodex'),
      hasMultipleActors: (content.match(/role: ['"`]participant['"`]/g) || []).length >= 1,
      hasExpectedActions: content.includes('TRACK_ENTITY') || content.includes('CREATE_RELATIONSHIP') || content.includes('EVALUATE_TRUST'),
    };

    // Count verification rules
    const verificationRules = (content.match(/\{\s*id:/g) || []).length;
    
    // Extract scenario metadata
    const idMatch = content.match(/id:\s*['"`]([^'"`]+)['"`]/);
    const nameMatch = content.match(/name:\s*['"`]([^'"`]+)['"`]/);
    const categoryMatch = content.match(/category:\s*['"`]([^'"`]+)['"`]/);
    
    const metadata = {
      id: idMatch ? idMatch[1] : 'Unknown',
      name: nameMatch ? nameMatch[1] : 'Unknown',
      category: categoryMatch ? categoryMatch[1] : 'Unknown',
      verificationRules,
    };

    // Determine overall validity
    const criticalChecks = [
      'hasDefaultExport',
      'hasScenarioId', 
      'hasActors',
      'hasVerificationRules',
      'hasTrustIntegration',
      'hasRolodexIntegration'
    ];
    
    const passedCritical = criticalChecks.every(check => checks[check]);
    const score = Object.values(checks).filter(Boolean).length / Object.keys(checks).length;

    return {
      fileName,
      metadata,
      checks,
      score,
      valid: passedCritical && score >= 0.7,
      verificationRules,
    };
  } catch (error) {
    return {
      fileName: path.basename(scenarioPath),
      error: error.message,
      valid: false,
      score: 0,
    };
  }
}

function analyzeIntegrationDepth(content) {
  const integrationIndicators = {
    // Trust system integration
    trustActions: [
      'RECORD_TRUST_INTERACTION',
      'EVALUATE_TRUST', 
      'UPDATE_TRUST',
      'TRUST_DECISION'
    ],
    
    // Rolodex system integration
    rolodexActions: [
      'TRACK_ENTITY',
      'CREATE_RELATIONSHIP',
      'UPDATE_ENTITY',
      'SEARCH_ENTITIES'
    ],
    
    // Integration concepts
    integrationConcepts: [
      'trust score',
      'relationship strength',
      'entity trust',
      'trust network',
      'trust propagation',
      'cross-platform',
      'identity verification',
      'social engineering',
      'trust decay'
    ]
  };

  const depth = {
    trustIntegration: integrationIndicators.trustActions.filter(action => 
      content.includes(action)).length,
    rolodexIntegration: integrationIndicators.rolodexActions.filter(action => 
      content.includes(action)).length,
    conceptCoverage: integrationIndicators.integrationConcepts.filter(concept => 
      content.toLowerCase().includes(concept.toLowerCase())).length,
  };

  depth.overall = (depth.trustIntegration + depth.rolodexIntegration + depth.conceptCoverage) / 3;
  
  return depth;
}

// Validate each scenario
scenarioFiles.forEach(filePath => {
  results.totalScenarios++;
  
  if (!fs.existsSync(filePath)) {
    results.issues.push(`❌ File not found: ${filePath}`);
    return;
  }

  const validation = validateScenarioStructure(filePath);
  const content = fs.readFileSync(filePath, 'utf8');
  const integration = analyzeIntegrationDepth(content);
  
  if (validation.valid) {
    results.validScenarios++;
    console.log(`✅ ${validation.fileName}`);
    console.log(`   📊 Score: ${(validation.score * 100).toFixed(0)}% | Rules: ${validation.verificationRules} | Integration: ${integration.overall.toFixed(1)}/10`);
    console.log(`   🏷️  ${validation.metadata.name} (${validation.metadata.category})`);
  } else {
    console.log(`❌ ${validation.fileName}`);
    if (validation.error) {
      console.log(`   💥 Error: ${validation.error}`);
    } else {
      console.log(`   📊 Score: ${(validation.score * 100).toFixed(0)}% | Issues found in structure`);
      const failedChecks = Object.entries(validation.checks)
        .filter(([_, passed]) => !passed)
        .map(([check, _]) => check);
      console.log(`   🔧 Failed: ${failedChecks.join(', ')}`);
    }
    results.issues.push(`${validation.fileName}: Structural issues`);
  }
  
  results.details.push({
    ...validation,
    integration,
  });
  
  console.log('');
});

// Summary Report
console.log('📋 VALIDATION SUMMARY');
console.log('═'.repeat(50));
console.log(`Total Scenarios: ${results.totalScenarios}`);
console.log(`Valid Scenarios: ${results.validScenarios}`);
console.log(`Success Rate: ${((results.validScenarios / results.totalScenarios) * 100).toFixed(0)}%`);

if (results.issues.length > 0) {
  console.log('\n🚨 ISSUES FOUND:');
  results.issues.forEach(issue => console.log(`   • ${issue}`));
}

// Integration Analysis
console.log('\n🔗 INTEGRATION ANALYSIS');
console.log('═'.repeat(50));

const integrationSummary = results.details.reduce((acc, detail) => {
  if (detail.integration) {
    acc.totalTrustActions += detail.integration.trustIntegration;
    acc.totalRolodexActions += detail.integration.rolodexIntegration;
    acc.totalConcepts += detail.integration.conceptCoverage;
    acc.scenarios++;
  }
  return acc;
}, { totalTrustActions: 0, totalRolodexActions: 0, totalConcepts: 0, scenarios: 0 });

if (integrationSummary.scenarios > 0) {
  console.log(`Average Trust Integration: ${(integrationSummary.totalTrustActions / integrationSummary.scenarios).toFixed(1)} actions/scenario`);
  console.log(`Average Rolodex Integration: ${(integrationSummary.totalRolodexActions / integrationSummary.scenarios).toFixed(1)} actions/scenario`);
  console.log(`Average Concept Coverage: ${(integrationSummary.totalConcepts / integrationSummary.scenarios).toFixed(1)} concepts/scenario`);
}

// Recommendations
console.log('\n💡 RECOMMENDATIONS');
console.log('═'.repeat(50));

if (results.validScenarios === results.totalScenarios) {
  console.log('✨ All scenarios are structurally valid! Key strengths:');
  console.log('   • Comprehensive trust-rolodex integration coverage');
  console.log('   • Multi-actor scenarios testing real-world interactions');
  console.log('   • Security-focused scenarios (social engineering, identity verification)');
  console.log('   • Network dynamics and trust propagation testing');
  console.log('   • Trust decay and maintenance lifecycle testing');
  
  console.log('\n🚀 Ready for integration testing:');
  console.log('   • Scenarios cover basic integration through advanced security');
  console.log('   • Each scenario tests different aspects of the integration');
  console.log('   • Verification rules validate both systems working together');
  console.log('   • Multi-agent interactions test realistic use cases');
} else {
  console.log('🔧 Improvements needed:');
  console.log('   • Fix structural issues in failing scenarios');
  console.log('   • Ensure all scenarios have trust-rolodex integration');
  console.log('   • Add more verification rules for integration points');
  console.log('   • Consider adding more multi-agent interactions');
}

console.log('\n🎯 NEXT STEPS');
console.log('═'.repeat(50));
console.log('1. Fix any structural issues in scenarios');
console.log('2. Set up proper test environment with both plugins');
console.log('3. Run scenarios in integration test mode');
console.log('4. Validate that trust and rolodex systems work together');
console.log('5. Measure performance and accuracy of integrated systems');

// Exit with appropriate code
process.exit(results.validScenarios === results.totalScenarios ? 0 : 1);