import { useState, useEffect } from 'react'
import {
  Folder,
  File,
  ChevronRight,
  RefreshCw,
  X,
  FileCode,
  FileJson,
  FileText,
  ArrowLeft
} from 'lucide-react'

interface FileEntry {
  name: string
  type: 'file' | 'directory'
  size: number | null
}

interface TrialFilesPanelProps {
  trialPath: string // e.g., "main-with-skills-pass1/task-name__xyz123"
  onClose: () => void
}

function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'json':
      return <FileJson className="w-4 h-4 text-yellow-500" />
    case 'py':
    case 'ts':
    case 'js':
    case 'tsx':
    case 'jsx':
      return <FileCode className="w-4 h-4 text-blue-500" />
    case 'txt':
    case 'md':
    case 'log':
      return <FileText className="w-4 h-4 text-gray-500" />
    default:
      return <File className="w-4 h-4 text-muted-foreground" />
  }
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function TrialFilesPanel({ trialPath, onClose }: TrialFilesPanelProps) {
  const [currentPath, setCurrentPath] = useState('')
  const [files, setFiles] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchFiles = async (subPath: string = '') => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ path: trialPath })
      if (subPath) params.append('subpath', subPath)

      const res = await fetch(`/api/files?${params}`)
      if (!res.ok) throw new Error('Failed to load files')

      const data = await res.json()
      setFiles(data.files)
      setCurrentPath(subPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load files')
    } finally {
      setLoading(false)
    }
  }

  const fetchFileContent = async (filePath: string) => {
    setFileLoading(true)
    setSelectedFile(filePath)
    setError(null)
    try {
      const fullPath = currentPath ? `${currentPath}/${filePath}` : filePath
      const params = new URLSearchParams({
        path: trialPath,
        file: fullPath
      })

      const res = await fetch(`/api/file?${params}`)
      if (!res.ok) throw new Error('Failed to load file')

      const contentType = res.headers.get('content-type')
      if (contentType?.includes('application/json')) {
        const json = await res.json()
        setFileContent(JSON.stringify(json, null, 2))
      } else {
        const data = await res.json()
        setFileContent(data.content)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load file')
      setFileContent(null)
    } finally {
      setFileLoading(false)
    }
  }

  useEffect(() => {
    fetchFiles()
  }, [trialPath])

  // Close on escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handleEntryClick = (entry: FileEntry) => {
    if (entry.type === 'directory') {
      const newPath = currentPath ? `${currentPath}/${entry.name}` : entry.name
      fetchFiles(newPath)
      setFileContent(null)
      setSelectedFile(null)
    } else {
      fetchFileContent(entry.name)
    }
  }

  const goUp = () => {
    const parentPath = currentPath.split('/').slice(0, -1).join('/')
    fetchFiles(parentPath)
    setFileContent(null)
    setSelectedFile(null)
  }

  const trialName = trialPath.split('/').pop() || trialPath
  const jobName = trialPath.split('/')[0] || ''

  return (
    // Modal overlay
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {/* Modal content */}
      <div className="bg-card border border-border rounded-lg shadow-2xl overflow-hidden flex flex-col w-[90vw] max-w-5xl h-[80vh]">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border flex items-center justify-between bg-muted/30 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Folder className="w-5 h-5 shrink-0 text-yellow-600" />
            <div className="flex flex-col min-w-0">
              <span className="font-medium truncate">{trialName}</span>
              <span className="text-xs text-muted-foreground truncate">{jobName}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => fetchFiles(currentPath)} className="p-2 hover:bg-muted rounded" title="Refresh">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={onClose} className="p-2 hover:bg-muted rounded" title="Close (Esc)">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Breadcrumb */}
        <div className="px-4 py-2 border-b border-border bg-muted/20 text-sm flex items-center gap-1 shrink-0 overflow-x-auto">
          <button
            onClick={() => { fetchFiles(''); setFileContent(null); setSelectedFile(null) }}
            className="hover:text-primary shrink-0 font-medium"
          >
            {trialName}
          </button>
          {currentPath && currentPath.split('/').map((part, idx, arr) => (
            <span key={idx} className="flex items-center gap-1 shrink-0">
              <ChevronRight className="w-3 h-3 text-muted-foreground" />
              <button
                onClick={() => {
                  const newPath = arr.slice(0, idx + 1).join('/')
                  fetchFiles(newPath)
                  setFileContent(null)
                  setSelectedFile(null)
                }}
                className="hover:text-primary"
              >
                {part}
              </button>
            </span>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* File list */}
          <div className={`${fileContent ? 'w-1/3 border-r border-border' : 'w-full'} overflow-auto`}>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : error ? (
              <div className="p-4 text-red-500">{error}</div>
            ) : (
              <div className="divide-y divide-border">
                {currentPath && (
                  <button
                    onClick={goUp}
                    className="w-full px-4 py-2.5 flex items-center gap-2 hover:bg-muted/50 text-left"
                  >
                    <ArrowLeft className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm">..</span>
                  </button>
                )}
                {files.map((entry) => (
                  <button
                    key={entry.name}
                    onClick={() => handleEntryClick(entry)}
                    className={`w-full px-4 py-2.5 flex items-center gap-3 hover:bg-muted/50 text-left ${
                      selectedFile === entry.name ? 'bg-primary/10' : ''
                    }`}
                  >
                    {entry.type === 'directory' ? (
                      <Folder className="w-5 h-5 text-yellow-600" />
                    ) : (
                      getFileIcon(entry.name)
                    )}
                    <span className="text-sm flex-1 truncate">{entry.name}</span>
                    {entry.size !== null && (
                      <span className="text-xs text-muted-foreground shrink-0">
                        {formatSize(entry.size)}
                      </span>
                    )}
                  </button>
                ))}
                {files.length === 0 && (
                  <div className="p-4 text-center text-muted-foreground">
                    Empty directory
                  </div>
                )}
              </div>
            )}
          </div>

          {/* File viewer */}
          {fileContent !== null && (
            <div className="flex-1 overflow-auto bg-muted/10">
              {fileLoading ? (
                <div className="flex items-center justify-center py-8">
                  <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <pre className="p-4 text-xs font-mono whitespace-pre-wrap break-words">
                  {fileContent}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
