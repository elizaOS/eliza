import { describe, test, expect, beforeEach } from 'vitest'
import { FormContextProvider, useFormContext } from '../src/providers/context'
import { renderHook } from '@testing-library/react'

describe('FormContextProvider', () => {
  // Helper to render hooks within provider context
  const renderFormContext = (initialProps?: any) => {
    return renderHook(() => useFormContext(), {
      wrapper: ({ children }) => (
        <FormContextProvider {...initialProps}>{children}</FormContextProvider>
      ),
    })
  }

  test('returns empty context with no session/stash', () => {
    const { result } = renderFormContext()
    expect(result.current.fields).toEqual([])
    expect(result.current.instructions).toBeUndefined()
  })

  test('returns proper field buckets with active session', () => {
    const mockSession = {
      fields: [
        { id: 'required1', required: true },
        { id: 'optional1', required: false },
        { id: 'uncertain1', uncertain: true },
      ],
    }
    
    const { result } = renderFormContext({ session: mockSession })
    
    expect(result.current.requiredFields).toHaveLength(1)
    expect(result.current.optionalFields).toHaveLength(1)
    expect(result.current.uncertainFields).toHaveLength(1)
  })

  test('resolves templates for field labels and descriptions', () => {
    const mockSession = {
      fields: [{
        id: 'field1',
        label: 'Enter {{value}}',
        description: 'Please provide {{detail}}',
        templateValues: {
          value: 'name',
          detail: 'full name'
        }
      }]
    }

    const { result } = renderFormContext({ session: mockSession })
    
    expect(result.current.fields[0].label).toBe('Enter name')
    expect(result.current.fields[0].description).toBe('Please provide full name')
  })

  describe('instruction priority logic', () => {
    test('external instruction takes highest priority', () => {
      const { result } = renderFormContext({
        session: { externalInstruction: 'External guidance' }
      })
      expect(result.current.instruction).toBe('External guidance')
    })

    test('cancel instruction takes priority after external', () => {
      const { result } = renderFormContext({
        session: { 
          cancelInstruction: 'Cancel guidance',
          requiredInstruction: 'Required guidance'
        }
      })
      expect(result.current.instruction).toBe('Cancel guidance')
    })

    test('uncertain instruction takes priority after cancel', () => {
      const { result } = renderFormContext({
        session: {
          uncertainInstruction: 'Uncertain guidance',
          requiredInstruction: 'Required guidance'
        }
      })
      expect(result.current.instruction).toBe('Uncertain guidance')
    })

    test('required instruction takes priority after uncertain', () => {
      const { result } = renderFormContext({
        session: {
          requiredInstruction: 'Required guidance',
          submitInstruction: 'Submit guidance'
        }
      })
      expect(result.current.instruction).toBe('Required guidance')
    })

    test('submit instruction has lowest priority', () => {
      const { result } = renderFormContext({
        session: {
          submitInstruction: 'Submit guidance'
        }
      })
      expect(result.current.instruction).toBe('Submit guidance')
    })
  })
})
