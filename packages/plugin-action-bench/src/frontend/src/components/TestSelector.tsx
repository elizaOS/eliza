import { useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import type { UUID } from '@elizaos/core';

interface TestOption {
  id: string
  label: string
  description: string
}

const testOptions: TestOption[] = [
  {
    id: 'typing-test',
    label: 'Test Hello Typing',
    description: 'This test evaluates the agent\'s ability to chain multiple typewriter actions together to spell out words and sentences. It measures action selection accuracy and response time.'
  },
  {
    id: 'conversation-test', 
    label: 'Test Hello and How Are You Typing',
    description: 'This test benchmarks conversational flow by having the agent respond to basic greetings and questions. It evaluates natural language understanding and appropriate response generation.'
  }
]

const TestSelector: React.FC = () => {
  const [selectedTest, setSelectedTest] = useState<string>(testOptions[0].id)
  const [isLoading, setIsLoading] = useState(false)
  const [lastResult, setLastResult] = useState<any>(null)
  
  const selectedOption = testOptions.find(option => option.id === selectedTest)

  // Generate a unique client ID (similar to how the main client does it)
  const generateClientId = () => {
    const USER_ID_KEY = 'elizaos-client-user-id';
    const existingUserId = localStorage.getItem(USER_ID_KEY);

    if (existingUserId) {
      return existingUserId as UUID;
    }

    const newUserId = uuidv4() as UUID;
    localStorage.setItem(USER_ID_KEY, newUserId);

    return newUserId;
  }

  // Execute test via backend API
  const executeTest = async (testType: string) => {
    try {
      const clientId = generateClientId();
      
      console.log(`🚀 Executing test: ${testType} with client ID: ${clientId}`);
      
      const response = await fetch('/action-bench/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          testType,
          clientId,
          baseUrl: window.location.origin // Pass the current origin to backend
        })
      });

      if (!response.ok) {
        throw new Error(`Test execution failed: ${response.statusText}`);
      }

      const result = await response.json();
      console.log('✅ Test completed:', result);
      
      setLastResult({
        success: true,
        message: result.message || 'Test executed successfully via backend route!',
        channelId: result.data?.channelId,
        testType: result.data?.testType,
        messageId: result.data?.messageId,
        agentResponse: result.data?.agentResponse,
        timestamp: result.data?.timestamp
      });

    } catch (error) {
      console.error('❌ Test execution failed:', error);
      setLastResult({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  return (
    <section className="bg-card border border-border rounded-lg p-6 mb-8">
      <h2 className="text-2xl font-semibold text-primary mb-6">🎯 Benchmark Test</h2>
      
      <div className="space-y-4">
        {/* Dropdown */}
        <div>
          <label htmlFor="test-select" className="block text-sm font-medium text-foreground mb-2">
            Select Test Scenario
          </label>
          <select
            id="test-select"
            value={selectedTest}
            onChange={(e) => setSelectedTest(e.target.value)}
            className="w-full px-3 py-2 bg-secondary border border-border rounded-md text-foreground focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-colors"
          >
            {testOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {/* Description */}
        {selectedOption && (
          <div className="bg-secondary/50 border border-primary/20 rounded-lg p-4">
            <h3 className="text-primary font-medium mb-2">📝 Test Description</h3>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {selectedOption.description}
            </p>
          </div>
        )}

        {/* Test Result Display */}
        {lastResult && (
          <div className={`border rounded-lg p-4 mb-4 ${lastResult.success ? 'border-green-500/20 bg-green-500/10' : 'border-red-500/20 bg-red-500/10'}`}>
            <h4 className="font-medium mb-2">{lastResult.success ? '✅ Success' : '❌ Error'}</h4>
            <div className="text-sm text-muted-foreground space-y-1">
              <p><strong>Message:</strong> {lastResult.message}</p>
              {lastResult.agentResponse && <p><strong>Agent Response:</strong> {lastResult.agentResponse}</p>}
              {lastResult.channelId && <p><strong>Channel ID:</strong> {lastResult.channelId}</p>}
              {lastResult.messageId && <p><strong>Message ID:</strong> {lastResult.messageId}</p>}
              {lastResult.testType && <p><strong>Test Type:</strong> {lastResult.testType}</p>}
              {lastResult.timestamp && <p><strong>Timestamp:</strong> {lastResult.timestamp}</p>}
              {lastResult.error && <p><strong>Error:</strong> {lastResult.error}</p>}
            </div>
          </div>
        )}

        {/* Start Button */}
        <div className="pt-2">
          <button 
            className={`btn-primary w-full sm:w-auto ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
            disabled={isLoading}
            onClick={async () => {
              if (isLoading) return
              
              setIsLoading(true)
              setLastResult(null)
              
              try {
                console.log(`🚀 Starting test via backend: ${selectedTest}`)
                await executeTest(selectedTest)
                console.log('✅ Test completed successfully!')
                
              } catch (error) {
                console.error('❌ Test execution failed:', error)
                // Error is already set in executeTest function
              } finally {
                setIsLoading(false)
              }
            }}
          >
            {isLoading ? '⏳ Running Test...' : '🚀 Run Test'}
          </button>
        </div>
      </div>
    </section>
  )
}

export default TestSelector
