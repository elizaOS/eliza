import { useState, useEffect } from 'react'
import { v4 as uuidv4 } from 'uuid'
import type { UUID } from '@elizaos/core';
import { TEST_DEFINITIONS } from '../../../shared/test-definitions';

interface TestOption {
  id: string
  label: string
  description: string
  steps: number
}

// Convert test definitions to frontend options
const testOptions: TestOption[] = TEST_DEFINITIONS.tests.map((test: any) => ({
  id: test.testId,
  label: test.name,
  description: `${test.steps.length} step${test.steps.length > 1 ? 's' : ''}: ${test.steps.map((step: any, i: number) => `${i + 1}) ${step.userMessage}`).join(' → ')}`,
  steps: test.steps.length
}))

const TestSelector: React.FC = () => {
  const [selectedTest, setSelectedTest] = useState<string>(testOptions[0].id)
  const [isLoading, setIsLoading] = useState(false)
  const [lastResult, setLastResult] = useState<any>(null)
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null)
  
  const selectedOption = testOptions.find(option => option.id === selectedTest)

  // Check for active test channel on mount
  useEffect(() => {
    const storedChannelId = localStorage.getItem('active-test-channel')
    const storedTestType = localStorage.getItem('active-test-type')
    
    if (storedChannelId && storedTestType) {
      console.log('🔄 Found active test channel:', storedChannelId, 'for test:', storedTestType)
      setActiveChannelId(storedChannelId)
      setSelectedTest(storedTestType)
      setIsLoading(true)
      
      // Continue with the test using the existing channel
      continueTestWithChannel(storedChannelId, storedTestType)
    }
  }, [])

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

  // Create a test channel with a predetermined ID
  const createTestChannelWithId = async (testType: string, clientId: UUID, channelId: UUID): Promise<void> => {
    console.log('🔗 Creating test channel with predetermined ID:', channelId)
    
    const requestBody = {
      testType,
      clientId,
      channelId, // Pass our predetermined ID
      baseUrl: window.location.origin
    }
    console.log('📤 Create channel request body:', requestBody)
    
    const response = await fetch('/action-bench/create-channel', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody)
    })

    console.log('📨 Create channel response status:', response.status)

    if (!response.ok) {
      const errorText = await response.text()
      console.error('❌ Create channel error response:', errorText)
      throw new Error(`Failed to create test channel: ${response.statusText} - ${errorText}`)
    }

    const result = await response.json()
    console.log('📦 Create channel result:', result)
    
    const returnedChannelId = result.data?.channelId
    
    if (returnedChannelId !== channelId) {
      console.warn('⚠️ Returned channel ID differs from requested:', { requested: channelId, returned: returnedChannelId })
    }

    console.log('✅ Test channel created with predetermined ID:', channelId)
  }

  // Continue test with existing channel
  const continueTestWithChannel = async (channelId: string, testType: string) => {
    try {
      console.log('▶️ Continuing test with channel:', channelId)
      
      const clientId = generateClientId()
      
      const requestBody = {
        testType,
        clientId,
        channelId, // Use existing channel
        baseUrl: window.location.origin
      }
      console.log('📤 Continue test request body:', requestBody)
      
      const response = await fetch('/action-bench/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
      })

      console.log('📨 Continue test response status:', response.status)

      if (!response.ok) {
        const errorText = await response.text()
        console.error('❌ Continue test error response:', errorText)
        throw new Error(`Test execution failed: ${response.statusText} - ${errorText}`)
      }

      const result = await response.json()
      console.log('✅ Test completed:', result)
      
      // Clear active channel from localStorage
      localStorage.removeItem('active-test-channel')
      localStorage.removeItem('active-test-type')
      setActiveChannelId(null)
      
      setLastResult({
        success: result.success,
        message: result.message,
        testResult: result.data?.testResult,
        channelId: result.data?.channelId,
        testType: result.data?.testType,
        timestamp: result.data?.timestamp
      })

    } catch (error) {
      console.error('❌ Test continuation failed:', error)
      
      // Clear active channel on error
      localStorage.removeItem('active-test-channel')
      localStorage.removeItem('active-test-type')
      setActiveChannelId(null)
      
      setLastResult({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setIsLoading(false)
    }
  }

  // Start a new test (generate channel ID first, then create)
  const startNewTest = async (testType: string) => {
    try {
      const clientId = generateClientId()
      
      console.log(`🚀 Starting new test: ${testType} with client ID: ${clientId}`)
      
      // Step 1: Generate channel ID BEFORE making any API calls
      const channelId = uuidv4() as UUID
      console.log('📋 Step 1: Pre-generated channel ID:', channelId)
      
      // Step 2: Store in localStorage IMMEDIATELY (before any API calls)
      console.log('📋 Step 2: Storing channel info in localStorage BEFORE API call...')
      localStorage.setItem('active-test-channel', channelId)
      localStorage.setItem('active-test-type', testType)
      setActiveChannelId(channelId)
      console.log('✅ Step 2 completed: Channel info stored BEFORE rerender risk')
      
      // Step 3: Create the channel with our predetermined ID
      console.log('📋 Step 3: Creating channel with predetermined ID...')
      await createTestChannelWithId(testType, clientId, channelId)
      console.log('✅ Step 3 completed: Channel created with our ID')
      
      console.log('📦 Channel ready and UI-rerender safe. Starting test execution...')
      
      // Step 4: Continue with the test using our predetermined channel
      console.log('📋 Step 4: Executing test with predetermined channel...')
      await continueTestWithChannel(channelId, testType)
      console.log('✅ Step 4 completed: Test execution finished')

    } catch (error) {
      console.error('❌ Test start failed:', error)
      
      // Clear any partial state on error
      localStorage.removeItem('active-test-channel')
      localStorage.removeItem('active-test-type')
      setActiveChannelId(null)
      
      setLastResult({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
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
            onChange={(e) => {
              console.log('🔄 Test selection changed, clearing previous results')
              setSelectedTest(e.target.value)
              setLastResult(null) // Clear previous results when changing test
            }}
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
            <div className="text-muted-foreground text-sm leading-relaxed space-y-2">
              <p><strong>Steps:</strong> {selectedOption.steps}</p>
              <p><strong>Flow:</strong> {selectedOption.description}</p>
              
              {/* Show detailed step breakdown */}
              {(() => {
                const testDef = TEST_DEFINITIONS.tests.find((t: any) => t.testId === selectedOption.id);
                if (!testDef) return null;
                
                return (
                  <div className="mt-3 space-y-1">
                    <p className="font-medium text-foreground">Step Details:</p>
                    {testDef.steps.map((step: any, i: number) => (
                      <div key={i} className="text-xs bg-secondary/30 rounded p-2">
                        <p><strong>Step {step.stepId}:</strong> {step.userMessage}</p>
                        <p className="text-muted-foreground mt-1">
                          Actions: [{step.expectedActions.join(', ')}]
                          {step.responseEvaluation.enabled && ' + Response Evaluation'}
                        </p>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* Test Result Display */}
        {lastResult && (
          <div className={`border rounded-lg p-4 mb-4 ${lastResult.success ? 'border-green-500/20 bg-green-500/10' : 'border-red-500/20 bg-red-500/10'}`}>
            <h4 className="font-medium mb-3">{lastResult.success ? '✅ Test Passed' : '❌ Test Failed'}</h4>
            
            <div className="text-sm text-muted-foreground space-y-2">
              <p><strong>Result:</strong> {lastResult.message}</p>
              
              {lastResult.testResult && (
                <div className="bg-secondary/30 rounded p-3 mt-3">
                  <h5 className="font-medium text-foreground mb-2">📊 Test Details</h5>
                  <div className="space-y-1">
                    <p><strong>Test:</strong> {lastResult.testResult.testName}</p>
                    <p><strong>Steps:</strong> {lastResult.testResult.successfulSteps}/{lastResult.testResult.totalSteps} passed ({Math.round(lastResult.testResult.successRate * 100)}%)</p>
                    <p><strong>Overall:</strong> {lastResult.testResult.overallPassed ? 'PASSED ✅' : 'FAILED ❌'}</p>
                  </div>
                  
                  {/* Step-by-step breakdown */}
                  {lastResult.testResult.stepResults && lastResult.testResult.stepResults.length > 0 && (
                    <div className="mt-3">
                      <h6 className="font-medium text-foreground mb-2">Step Results:</h6>
                      <div className="space-y-2">
                        {lastResult.testResult.stepResults.map((step: any, index: number) => (
                          <div key={index} className={`text-xs p-2 rounded ${step.passed ? 'bg-green-500/10 border border-green-500/20' : 'bg-red-500/10 border border-red-500/20'}`}>
                            <div className="flex justify-between items-start">
                              <span><strong>Step {step.stepId}:</strong> {step.passed ? '✅' : '❌'}</span>
                            </div>
                            <p className="mt-1 text-muted-foreground">Actions: [{step.collectedActions.join(', ')}]</p>
                            <p className="text-muted-foreground">Result: {step.actionEvaluation.details}</p>
                            {step.responseEvaluation && (
                              <p className="text-muted-foreground">Response: {step.responseEvaluation.reasoning} (Score: {step.responseEvaluation.score})</p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              
              {lastResult.channelId && <p><strong>Channel ID:</strong> {lastResult.channelId}</p>}
              {lastResult.testType && <p><strong>Test Type:</strong> {lastResult.testType}</p>}
              {lastResult.timestamp && <p><strong>Timestamp:</strong> {lastResult.timestamp}</p>}
              {lastResult.error && <p className="text-red-400"><strong>Error:</strong> {lastResult.error}</p>}
            </div>
          </div>
        )}

        {/* Start Button */}
        <div className="pt-2">
          <button 
            className={`btn-primary w-full sm:w-auto ${(isLoading || !!activeChannelId) ? 'opacity-50 cursor-not-allowed' : ''}`}
            disabled={isLoading || !!activeChannelId}
            onClick={async () => {
              if (isLoading || activeChannelId) return
              
              setIsLoading(true)
              setLastResult(null)
              
              try {
                console.log(`🚀 Starting test via backend: ${selectedTest}`)
                await startNewTest(selectedTest)
                console.log('✅ Test completed successfully!')
                
              } catch (error) {
                console.error('❌ Test execution failed:', error)
                // Error is already set in startNewTest function
              } finally {
                setIsLoading(false)
              }
            }}
          >
            {activeChannelId 
              ? '🔄 Test in Progress...' 
              : isLoading 
                ? '⏳ Starting Test...' 
                : '🚀 Run Test'
            }
          </button>
          
          {/* Show active channel info */}
          {activeChannelId && (
            <div className="mt-2 text-sm text-muted-foreground">
              <p>🔗 Active test channel: <code className="text-xs bg-secondary px-1 py-0.5 rounded">{activeChannelId.slice(0, 8)}...</code></p>
              <p className="text-xs mt-1">The test will continue automatically if the page refreshes.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

export default TestSelector
