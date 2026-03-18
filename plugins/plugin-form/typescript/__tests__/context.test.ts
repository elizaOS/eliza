import { describe, test, expect, vi, beforeEach } from 'vitest'
import { formContextProvider } from '../src/providers/context'
import type { IAgentRuntime, Memory, State, UUID } from '@elizaos/core'

// Mock the logger
vi.mock('@elizaos/core', async () => {
  const actual = await vi.importActual('@elizaos/core')
  return {
    ...actual,
    logger: {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    },
  }
})

describe('formContextProvider', () => {
  let mockRuntime: IAgentRuntime
  let mockMessage: Memory
  let mockState: State
  let mockFormService: any

  beforeEach(() => {
    mockFormService = {
      getActiveSession: vi.fn(),
      getStashedSessions: vi.fn(),
      getSessionContext: vi.fn(),
      getForm: vi.fn(),
    }

    mockRuntime = {
      getService: vi.fn().mockResolvedValue(mockFormService),
    } as unknown as IAgentRuntime

    mockMessage = {
      entityId: 'entity-123' as UUID,
      roomId: 'room-456' as UUID,
    } as Memory

    mockState = {} as State
  })

  test('returns empty context when no form service available', async () => {
    ;(mockRuntime.getService as any).mockResolvedValue(null)

    const result = await formContextProvider.get(mockRuntime, mockMessage, mockState)

    expect(result.data).toEqual({ hasActiveForm: false })
    expect(result.values).toEqual({ formContext: '' })
    expect(result.text).toBe('')
  })

  test('returns empty context when no entityId or roomId', async () => {
    mockMessage.entityId = undefined as any

    const result = await formContextProvider.get(mockRuntime, mockMessage, mockState)

    expect(result.data).toEqual({ hasActiveForm: false })
  })

  test('returns empty context when no active session and no stashed forms', async () => {
    mockFormService.getActiveSession.mockResolvedValue(null)
    mockFormService.getStashedSessions.mockResolvedValue([])

    const result = await formContextProvider.get(mockRuntime, mockMessage, mockState)

    expect(result.data).toEqual({ hasActiveForm: false, stashedCount: 0 })
    expect(result.text).toBe('')
  })

  test('returns context with active session data', async () => {
    const mockSession = {
      formId: 'test-form',
      fields: { name: 'John' },
    }
    const mockContextState = {
      hasActiveForm: true,
      progress: 50,
      filledFields: [{ key: 'name', label: 'Name', displayValue: 'John' }],
      missingRequired: [{ key: 'email', label: 'Email' }],
      uncertainFields: [],
      nextField: null,
      pendingExternalFields: [],
      status: 'in_progress',
    }

    mockFormService.getActiveSession.mockResolvedValue(mockSession)
    mockFormService.getStashedSessions.mockResolvedValue([])
    mockFormService.getSessionContext.mockReturnValue(mockContextState)
    mockFormService.getForm.mockReturnValue({ name: 'Test Form', controls: [] })

    const result = await formContextProvider.get(mockRuntime, mockMessage, mockState)

    expect(result.data.hasActiveForm).toBe(true)
    expect(result.data.progress).toBe(50)
    expect(result.text).toContain('Active Form: Test Form')
    expect(result.text).toContain('Progress: 50%')
  })

  test('includes stashed forms in context', async () => {
    const mockStashedSession = {
      formId: 'stashed-form',
      fields: {},
    }
    const mockContextState = {
      hasActiveForm: false,
      progress: 25,
      filledFields: [],
      missingRequired: [],
      uncertainFields: [],
      nextField: null,
      pendingExternalFields: [],
    }

    mockFormService.getActiveSession.mockResolvedValue(null)
    mockFormService.getStashedSessions.mockResolvedValue([mockStashedSession])
    mockFormService.getSessionContext.mockReturnValue(mockContextState)
    mockFormService.getForm.mockReturnValue({ name: 'Stashed Form' })

    const result = await formContextProvider.get(mockRuntime, mockMessage, mockState)

    expect(result.data.stashedCount).toBe(1)
    expect(result.text).toContain('Saved forms:')
    expect(result.text).toContain('1 saved form(s)')
  })

  test('handles errors gracefully', async () => {
    ;(mockRuntime.getService as any).mockRejectedValue(new Error('Service error'))

    const result = await formContextProvider.get(mockRuntime, mockMessage, mockState)

    expect(result.data).toEqual({ hasActiveForm: false, error: true })
    expect(result.text).toBe('Error loading form context.')
  })
})
