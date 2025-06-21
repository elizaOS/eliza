#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// List of files and their specific fixes
const fixes = [
  // Unused variables - remove them
  {
    file: 'tests/unit/scenario-runner/verification-engines.test.ts',
    line: 289,
    type: 'remove-line',
    match: "const levels = ['secret', 'confidential', 'internal', 'public'];"
  },
  
  // Character import fixes
  {
    file: 'tests/my-create-app/src/__tests__/character.test.ts',
    type: 'replace',
    from: "import { character } from '../index';",
    to: "import { character } from '../characters/default';"
  },
  {
    file: 'tests/my-default-app/src/__tests__/character.test.ts',
    type: 'replace',
    from: "import { character } from '../index';",
    to: "import { character } from '../characters/default';"
  },
  {
    file: 'tests/create-in-place/src/__tests__/character.test.ts',
    type: 'replace',
    from: "import { character } from '../index';",
    to: "import { character } from '../characters/default';"
  },
  
  // UUID type fixes - add 'as UUID' cast
  {
    file: 'tests/plugin-my-create/src/__tests__/test-utils.ts',
    type: 'replace',
    from: "agentId: 'test-agent-id',",
    to: "agentId: 'test-agent-id' as UUID,"
  },
  {
    file: 'tests/plugin-my-plugin-app/src/__tests__/test-utils.ts',
    type: 'replace',
    from: "agentId: 'test-agent-id',",
    to: "agentId: 'test-agent-id' as UUID,"
  },
  {
    file: 'tests/my-create-app/src/__tests__/test-utils.ts',
    type: 'replace',
    from: "agentId: 'test-agent-id',",
    to: "agentId: 'test-agent-id' as UUID,"
  },
  {
    file: 'tests/my-default-app/src/__tests__/test-utils.ts',
    type: 'replace',
    from: "agentId: 'test-agent-id',",
    to: "agentId: 'test-agent-id' as UUID,"
  },
  {
    file: 'tests/create-in-place/src/__tests__/test-utils.ts',
    type: 'replace',
    from: "agentId: 'test-agent-id',",
    to: "agentId: 'test-agent-id' as UUID,"
  },
  
  // Add UUID import where missing
  {
    file: 'tests/plugin-my-create/src/__tests__/test-utils.ts',
    type: 'add-import',
    import: "import type { UUID } from '@elizaos/core';"
  },
  {
    file: 'tests/plugin-my-plugin-app/src/__tests__/test-utils.ts',
    type: 'add-import',
    import: "import type { UUID } from '@elizaos/core';"
  },
  {
    file: 'tests/my-create-app/src/__tests__/test-utils.ts',
    type: 'add-import',
    import: "import type { UUID } from '@elizaos/core';"
  },
  {
    file: 'tests/my-default-app/src/__tests__/test-utils.ts',
    type: 'add-import',
    import: "import type { UUID } from '@elizaos/core';"
  },
  {
    file: 'tests/create-in-place/src/__tests__/test-utils.ts',
    type: 'add-import',
    import: "import type { UUID } from '@elizaos/core';"
  }
];

// Apply fixes
fixes.forEach(fix => {
  const filePath = path.join(__dirname, fix.file);
  
  if (!fs.existsSync(filePath)) {
    console.warn(`File not found: ${filePath}`);
    return;
  }
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  switch (fix.type) {
    case 'replace':
      content = content.replace(fix.from, fix.to);
      break;
      
    case 'remove-line':
      content = content.split('\n').filter(line => !line.includes(fix.match)).join('\n');
      break;
      
    case 'add-import':
      // Add import after the first line if not already present
      if (!content.includes(fix.import)) {
        const lines = content.split('\n');
        lines.splice(1, 0, fix.import);
        content = lines.join('\n');
      }
      break;
  }
  
  fs.writeFileSync(filePath, content);
  console.log(`Fixed: ${fix.file}`);
});

console.log('Done!'); 