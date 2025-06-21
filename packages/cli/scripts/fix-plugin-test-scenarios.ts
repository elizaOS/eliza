#!/usr/bin/env bun

import * as fs from 'fs';
import * as path from 'path';

// Map of action names to their descriptions
const actionDescriptions: Record<string, string> = {
  LIST_GITHUB_ISSUES: 'fetch issues from the GitHub repository',
  CREATE_TODO: 'create todo items',
  UPDATE_TODO: 'update the status of a todo item',
  CREATE_GITHUB_PR: 'create a pull request',
  COMPLETE_TODO: 'mark a todo item as completed',
  RESEARCH_TOPIC: 'perform research on the specified topic',
  SYNTHESIZE_KNOWLEDGE: 'synthesize research findings into coherent knowledge',
  CREATE_KNOWLEDGE_ENTRY: 'create a knowledge base entry',
  GENERATE_REPORT: 'generate a comprehensive report',
  CREATE_PLAN: 'create an execution plan',
  EXECUTE_STEP: 'execute a plan step',
  UPDATE_PLAN: 'update the plan status',
  COMPLETE_PLAN: 'mark the plan as completed',
  REVIEW_PLAN: 'review and evaluate the plan execution',
  ADD_CONTACT: 'add a new contact to the rolodex',
  UPDATE_RELATIONSHIP: 'update relationship information',
  QUERY_RELATIONSHIPS: 'query relationship data',
  NAVIGATE_TO_URL: 'navigate to a web URL',
  EXTRACT_DATA: 'extract data from web pages',
  FILL_FORM: 'fill out web forms',
  CAPTURE_SCREENSHOT: 'capture a screenshot',
  ANALYZE_PAGE: 'analyze web page content',
  CHECK_WALLET_BALANCE: 'check blockchain wallet balance',
  EXECUTE_SWAP: 'execute a token swap',
  PROVIDE_LIQUIDITY: 'provide liquidity to a pool',
  MONITOR_POSITION: 'monitor DeFi position',
  INSTALL_PLUGIN: 'install a new plugin',
  ACTIVATE_PLUGIN: 'activate an installed plugin',
  DEACTIVATE_PLUGIN: 'deactivate a plugin',
  UPDATE_PLUGIN: 'update a plugin to latest version',
  LIST_PLUGINS: 'list all available plugins',
  VERIFY_COMPATIBILITY: 'verify plugin compatibility',
  ENCRYPT_SECRET: 'encrypt sensitive data',
  STORE_SECRET: 'store encrypted secret',
  RETRIEVE_SECRET: 'retrieve and decrypt secret',
  ROTATE_KEYS: 'rotate encryption keys',
  AUDIT_ACCESS: 'audit secret access logs',
  GATHER_EVIDENCE: 'gather evidence for investigation',
  ANALYZE_PATTERNS: 'analyze patterns in data',
  GENERATE_HYPOTHESIS: 'generate investigation hypothesis',
  VERIFY_FINDINGS: 'verify investigation findings',
  CREATE_REPORT: 'create investigation report',
  DEPLOY_CODE: 'deploy code to production',
  RUN_TESTS: 'run automated tests',
  CHECK_STATUS: 'check deployment status',
  ROLLBACK: 'rollback deployment if needed',
  VERIFY_DEPLOYMENT: 'verify successful deployment',
  ASSESS_SITUATION: 'assess crisis situation',
  NOTIFY_STAKEHOLDERS: 'notify relevant stakeholders',
  COORDINATE_RESPONSE: 'coordinate crisis response',
  EXECUTE_MITIGATION: 'execute mitigation actions',
  CREATE_NODE: 'create knowledge graph node',
  CREATE_EDGE: 'create relationship edge',
  QUERY_GRAPH: 'query knowledge graph',
  UPDATE_NODE: 'update node properties',
  VISUALIZE_GRAPH: 'visualize the knowledge graph',
  FETCH_TRANSACTIONS: 'fetch blockchain transactions',
  ANALYZE_TRANSACTION_PATTERNS: 'analyze transaction patterns',
  TRACK_FUNDS: 'track fund movements',
  GENERATE_BLOCKCHAIN_INSIGHTS: 'generate analytical insights',
};

function generateCriteria(actionName: string, description: string): string {
  const actionDesc = actionDescriptions[actionName] || `perform the ${actionName} action`;
  return `The agent must have successfully executed the ${actionName} action to ${actionDesc}`;
}

function fixVerificationRule(rule: string): string {
  // First, replace the type
  let fixed = rule.replace(/type:\s*['"]action_taken['"]/, "type: 'llm'");

  // Extract the expectedValue if it exists
  const expectedValueMatch = fixed.match(/expectedValue:\s*['"]([^'"]+)['"]/);
  if (expectedValueMatch) {
    const expectedValue = expectedValueMatch[1];
    const descriptionMatch = fixed.match(/description:\s*['"]([^'"]+)['"]/);
    const description = descriptionMatch ? descriptionMatch[1] : '';

    // Generate criteria
    const criteria = generateCriteria(expectedValue, description);

    // Replace the simple config with enhanced config
    fixed = fixed.replace(
      /config:\s*{\s*expectedValue:\s*['"]([^'"]+)['"]\s*}/,
      `config: {
          criteria: '${criteria}',
          priority: 'high',
          category: 'action_execution',
          context: {
            expectedAction: '${expectedValue}',
            expectedValue: '${expectedValue}',
          },
        }`
    );
  }

  // Handle other verification types
  fixed = fixed.replace(/type:\s*['"]interaction_count['"]/, "type: 'llm'");
  fixed = fixed.replace(/type:\s*['"]plugin_state['"]/, "type: 'llm'");
  fixed = fixed.replace(/type:\s*['"]trust_verified['"]/, "type: 'llm'");
  fixed = fixed.replace(/type:\s*['"]trust_impact['"]/, "type: 'llm'");

  return fixed;
}

async function fixScenarioFile(filePath: string) {
  console.log(`\n📄 Processing: ${path.basename(filePath)}`);

  let content = fs.readFileSync(filePath, 'utf-8');
  const originalContent = content;

  // Find all verification rules blocks
  const verificationBlockRegex = /verification:\s*{[\s\S]*?rules:\s*\[([\s\S]*?)\]/g;
  let match;

  while ((match = verificationBlockRegex.exec(content)) !== null) {
    const rulesBlock = match[1];

    // Split into individual rules
    const ruleRegex = /{[^{}]*(?:{[^{}]*}[^{}]*)*}/g;
    const rules = rulesBlock.match(ruleRegex) || [];

    let fixedRules = rules.map((rule) => {
      if (
        rule.includes("type: 'action_taken'") ||
        rule.includes('type: "action_taken"') ||
        rule.includes("type: 'interaction_count'") ||
        rule.includes("type: 'plugin_state'") ||
        rule.includes("type: 'trust_verified'") ||
        rule.includes("type: 'trust_impact'")
      ) {
        return fixVerificationRule(rule);
      }
      return rule;
    });

    // Reconstruct the rules block
    const fixedRulesBlock = fixedRules.join(',\n      ');
    const fixedVerificationBlock = match[0].replace(rulesBlock, `\n      ${fixedRulesBlock}\n    `);

    content = content.replace(match[0], fixedVerificationBlock);
  }

  if (content !== originalContent) {
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`  ✅ Fixed verification rules`);

    // Count the changes
    const actionTakenCount = (originalContent.match(/type:\s*['"]action_taken['"]/g) || []).length;
    const otherCount = (
      originalContent.match(
        /type:\s*['"](interaction_count|plugin_state|trust_verified|trust_impact)['"]/g
      ) || []
    ).length;

    if (actionTakenCount > 0) {
      console.log(`  📝 Converted ${actionTakenCount} action_taken rules to LLM verification`);
    }
    if (otherCount > 0) {
      console.log(`  📝 Converted ${otherCount} other verification types to LLM`);
    }
  } else {
    console.log(`  ⏭️  No changes needed`);
  }
}

async function main() {
  const scenarioDir = path.join(process.cwd(), 'packages/cli/scenarios/plugin-tests');

  if (!fs.existsSync(scenarioDir)) {
    console.error(`❌ Directory not found: ${scenarioDir}`);
    console.error('Please run this script from the root of the project');
    process.exit(1);
  }

  const files = fs
    .readdirSync(scenarioDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(scenarioDir, f));

  console.log(`🔍 Found ${files.length} scenario files to process`);
  console.log('━'.repeat(50));

  for (const file of files) {
    await fixScenarioFile(file);
  }

  console.log('\n━'.repeat(50));
  console.log('✨ All scenario files have been processed!');
  console.log('\n📌 Next steps:');
  console.log('  1. Run: cd packages/cli && npm run build');
  console.log('  2. Run: npm run test:scenarios');
  console.log('  3. Review the test results');
}

// Run the script
main().catch(console.error);
