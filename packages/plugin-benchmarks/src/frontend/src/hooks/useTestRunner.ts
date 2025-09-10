import { useCallback } from 'react'

interface TestConfig {
  id: string
  label: string
  type: 'info' | 'warning' | 'error' | 'success'
  message: string
}

export const useTestRunner = () => {
  const runTest = useCallback((test: TestConfig) => {
    // Log to console based on test type
    switch (test.type) {
      case 'info':
        console.info(`🔵 Action Bench: Info test (${test.id}) executed successfully!`)
        break
      case 'warning':
        console.warn(`🟡 Action Bench: Warning test (${test.id}) executed!`)
        break
      case 'error':
        console.error(`🔴 Action Bench: Error test (${test.id}) executed (this is intentional)!`)
        break
      case 'success':
        console.log(`🟢 Action Bench: Success test (${test.id}) executed!`)
        break
    }

    // Show alert with the test message
    alert(test.message)
  }, [])

  const showTypewriterInfo = useCallback(() => {
    const info = 'Action Bench provides 26 typewriter actions:\\n\\n' +
                 '• TYPE_A through TYPE_Z\\n' +
                 '• Each action appends its letter to state.typedText\\n' +
                 '• Perfect for testing action chaining\\n' +
                 '• Great for benchmarking LLM action selection\\n\\n' +
                 'Example usage: Ask the agent to "type hello" and watch it chain TYPE_H, TYPE_E, TYPE_L, TYPE_L, TYPE_O actions!'
    alert(info)
  }, [])

  const showBenchmarkHelp = useCallback(() => {
    const help = 'How to use Action Bench for benchmarking:\\n\\n' +
                 '1️⃣ Start a conversation with your agent\\n' +
                 '2️⃣ Ask it to type words or sentences\\n' +
                 '3️⃣ Observe how well it chains the letter actions\\n' +
                 '4️⃣ Test with different complexity levels:\\n' +
                 '   • Short words (3-5 letters)\\n' +
                 '   • Medium phrases (10-20 letters)\\n' +
                 '   • Long sentences (50+ letters)\\n\\n' +
                 '📊 Monitor response times and accuracy for performance insights!'
    alert(help)
  }, [])

  return {
    runTest,
    showTypewriterInfo,
    showBenchmarkHelp
  }
}
