#!/usr/bin/env bats

load '../helpers/test-helpers'
load '../helpers/environment-helpers'

setup() {
  setup_test_environment
  cd "$TEST_DIR"
}

teardown() {
  teardown_test_environment
}

@test "scenario command exists" {
  run elizaos scenario --help
  assert_success
  assert_output --partial "Run and manage scenario tests"
}

@test "scenario generate command exists" {
  run elizaos scenario generate --help
  assert_success
  assert_output --partial "Generate a new scenario"
}

@test "scenario run command exists" {
  run elizaos scenario run --help
  assert_success
  assert_output --partial "Run scenario tests"
}

@test "scenario test command exists" {
  run elizaos scenario test --help
  assert_success
  assert_output --partial "Run scenario tests"
}

@test "scenario generate creates new scenario" {
  run elizaos scenario generate "Test scenario for BATS" --output test-scenario.ts
  assert_success
  assert_output --partial "Generated scenario"
  
  # Verify the scenario file was created
  assert_file_exists "test-scenario.ts"
}

@test "scenario run requires options" {
  run elizaos scenario run
  assert_failure
  assert_output --partial "required"
}

@test "scenario run with non-existent file fails" {
  run elizaos scenario run --file non-existent-scenario.ts
  assert_failure
  assert_output --partial "not found"
}

@test "scenario test is alias for run" {
  run elizaos scenario test --help
  assert_success
  assert_output --partial "Run scenario tests"
}

@test "scenario list shows available scenarios" {
  run elizaos scenario list
  assert_success
  assert_output --partial "Available scenarios:"
}

@test "scenario run with invalid scenario fails" {
  run elizaos scenario run non-existent-scenario
  assert_failure
  assert_output --partial "Scenario not found"
}

@test "scenario validate checks scenario syntax" {
  # Create a test scenario file
  cat > test-scenario.ts << 'EOF'
export const testScenario = {
  id: 'test-scenario',
  name: 'Test Scenario',
  description: 'A test scenario',
  actors: [{
    id: '123e4567-e89b-12d3-a456-426614174000',
    name: 'TestBot',
    role: 'subject'
  }],
  execution: {
    steps: [{
      type: 'message',
      actorId: '123e4567-e89b-12d3-a456-426614174000',
      content: 'Hello world'
    }]
  },
  verification: {
    rules: [{
      id: 'rule-1',
      type: 'llm',
      description: 'Check greeting'
    }]
  }
};
EOF

  run elizaos scenario validate test-scenario.ts
  assert_success
  assert_output --partial "Scenario is valid"
}

@test "scenario run executes simple scenario" {
  # Create a simple test scenario
  mkdir -p scenarios
  cat > scenarios/simple-test.ts << 'EOF'
export const simpleTest = {
  id: 'simple-test',
  name: 'Simple Test',
  description: 'A simple test scenario',
  actors: [{
    id: '123e4567-e89b-12d3-a456-426614174000',
    name: 'TestBot',
    role: 'subject',
    script: {
      steps: [{
        type: 'message',
        content: 'Hello from test'
      }]
    }
  }],
  setup: {},
  execution: {
    steps: [{
      type: 'message',
      actorId: '123e4567-e89b-12d3-a456-426614174000',
      content: 'Start test'
    }]
  },
  verification: {
    rules: [{
      id: 'check-response',
      type: 'llm',
      description: 'Agent should respond',
      config: {
        expectedBehavior: 'Agent responds to greeting'
      }
    }]
  }
};
export default simpleTest;
EOF

  # Run the scenario with a timeout
  run timeout 30s elizaos scenario run simple-test --verbose
  assert_success
  assert_output --partial "Running scenario: Simple Test"
  assert_output --partial "Scenario completed"
}

@test "scenario run with multiple agents" {
  # Create a multi-agent scenario
  cat > scenarios/multi-agent.ts << 'EOF'
export const multiAgent = {
  id: 'multi-agent',
  name: 'Multi Agent Test',
  description: 'Test with multiple agents',
  actors: [
    {
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Agent1',
      role: 'subject'
    },
    {
      id: '223e4567-e89b-12d3-a456-426614174001',
      name: 'Agent2',
      role: 'assistant'
    }
  ],
  execution: {
    steps: [
      {
        type: 'message',
        actorId: '223e4567-e89b-12d3-a456-426614174001',
        content: 'Hello Agent1'
      },
      {
        type: 'wait',
        duration: 1000
      },
      {
        type: 'message',
        actorId: '123e4567-e89b-12d3-a456-426614174000',
        content: 'Hello Agent2'
      }
    ]
  },
  verification: {
    rules: [{
      id: 'check-interaction',
      type: 'llm',
      description: 'Agents should interact',
      config: {
        expectedBehavior: 'Both agents exchange greetings'
      }
    }]
  }
};
export default multiAgent;
EOF

  run timeout 45s elizaos scenario run multi-agent
  assert_success
  assert_output --partial "Created isolated runtime for actor Agent1"
  assert_output --partial "Created isolated runtime for actor Agent2"
}

@test "scenario metrics are collected" {
  run timeout 30s elizaos scenario run simple-test --metrics
  assert_success
  assert_output --partial "Metrics:"
  assert_output --partial "Duration:"
  assert_output --partial "Messages:"
}

@test "scenario results can be exported" {
  run timeout 30s elizaos scenario run simple-test --output results.json
  assert_success
  assert_file_exists "results.json"
  
  # Verify JSON structure
  run jq '.scenarioId' results.json
  assert_success
  assert_output '"simple-test"'
}

@test "scenario can run with custom config" {
  # Create a config file
  cat > scenario-config.json << 'EOF'
{
  "timeout": 60000,
  "verbose": true,
  "parallel": false
}
EOF

  run timeout 30s elizaos scenario run simple-test --config scenario-config.json
  assert_success
  assert_output --partial "Using config from scenario-config.json"
}

@test "scenario handles errors gracefully" {
  # Create a scenario with an error
  cat > scenarios/error-test.ts << 'EOF'
export const errorTest = {
  id: 'error-test',
  name: 'Error Test',
  actors: [], // No actors - should fail validation
  execution: {},
  verification: {}
};
export default errorTest;
EOF

  run elizaos scenario run error-test
  assert_failure
  assert_output --partial "Scenario must have at least one actor"
}

@test "scenario benchmark mode" {
  run timeout 60s elizaos scenario run simple-test --benchmark --iterations 3
  assert_success
  assert_output --partial "Benchmark Results:"
  assert_output --partial "Average duration:"
  assert_output --partial "Min duration:"
  assert_output --partial "Max duration:"
} 