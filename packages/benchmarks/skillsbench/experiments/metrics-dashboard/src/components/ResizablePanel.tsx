import { useState, useRef, useCallback, useEffect } from 'react'

interface ResizablePanelProps {
  left: React.ReactNode
  right: React.ReactNode
  defaultLeftWidth?: number // percentage
  minLeftWidth?: number // percentage
  maxLeftWidth?: number // percentage
  className?: string
}

export function ResizablePanel({
  left,
  right,
  defaultLeftWidth = 50,
  minLeftWidth = 20,
  maxLeftWidth = 80,
  className = '',
}: ResizablePanelProps) {
  const [leftWidth, setLeftWidth] = useState(defaultLeftWidth)
  const [isDragging, setIsDragging] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging || !containerRef.current) return

      const container = containerRef.current
      const rect = container.getBoundingClientRect()
      const x = e.clientX - rect.left
      const percentage = (x / rect.width) * 100

      const clampedPercentage = Math.min(Math.max(percentage, minLeftWidth), maxLeftWidth)
      setLeftWidth(clampedPercentage)
    },
    [isDragging, minLeftWidth, maxLeftWidth]
  )

  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
  }, [])

  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    } else {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isDragging, handleMouseMove, handleMouseUp])

  return (
    <div ref={containerRef} className={`flex h-full ${className}`}>
      {/* Left panel */}
      <div style={{ width: `${leftWidth}%` }} className="overflow-auto">
        {left}
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={handleMouseDown}
        className={`w-1 bg-border hover:bg-primary/50 cursor-col-resize transition-colors flex-shrink-0 ${
          isDragging ? 'bg-primary/50' : ''
        }`}
      />

      {/* Right panel */}
      <div style={{ width: `${100 - leftWidth}%` }} className="overflow-auto">
        {right}
      </div>
    </div>
  )
}
