import { useState, useEffect, useCallback } from 'react'
import type { MetricsRegistry } from '../types/metrics'

const API_URL = '/api/metrics'

const DEFAULT_POLL_INTERVAL = 5000 // 5 seconds

interface UseMetricsOptions {
  pollInterval?: number
  enabled?: boolean
}

interface UseMetricsResult {
  data: MetricsRegistry | null
  isLoading: boolean
  error: string | null
  lastUpdated: Date | null
  refetch: () => Promise<void>
}

export function useMetrics(options: UseMetricsOptions = {}): UseMetricsResult {
  const { pollInterval = DEFAULT_POLL_INTERVAL, enabled = true } = options

  const [data, setData] = useState<MetricsRegistry | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const fetchMetrics = useCallback(async () => {
    try {
      const response = await fetch(API_URL)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      const metrics: MetricsRegistry = await response.json()
      setData(metrics)
      setError(null)
      setLastUpdated(new Date())
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to fetch metrics'
      setError(message)
      console.error('Failed to fetch metrics:', e)
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Initial fetch
  useEffect(() => {
    if (enabled) {
      fetchMetrics()
    }
  }, [enabled, fetchMetrics])

  // Polling
  useEffect(() => {
    if (!enabled || pollInterval <= 0) return

    const interval = setInterval(fetchMetrics, pollInterval)
    return () => clearInterval(interval)
  }, [enabled, pollInterval, fetchMetrics])

  return {
    data,
    isLoading,
    error,
    lastUpdated,
    refetch: fetchMetrics,
  }
}
