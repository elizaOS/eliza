import React from 'react'
import { useTestRunner } from '../hooks/useTestRunner'

export interface TestButtonProps {
  test: {
    id: string
    label: string
    type: 'info' | 'warning' | 'error' | 'success'
    message: string
  }
}

const TestButton: React.FC<TestButtonProps> = ({ test }) => {
  const { runTest } = useTestRunner()

  const handleClick = () => {
    runTest(test)
  }

  return (
    <button 
      className="btn-primary test-button" 
      onClick={handleClick}
    >
      {test.label}
    </button>
  )
}

export default TestButton
