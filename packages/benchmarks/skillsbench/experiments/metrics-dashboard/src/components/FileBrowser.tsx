import { useState, useEffect } from 'react'
import { Folder, File, ChevronRight, ArrowLeft, Loader2, FileJson, FileText, FileCode } from 'lucide-react'
import { ResizablePanel } from './ResizablePanel'

interface FileEntry {
  name: string
  type: 'file' | 'directory'
  size: number | null
}

interface FileBrowserProps {
  trialPath: string
}

export function FileBrowser({ trialPath }: FileBrowserProps) {
  const [currentPath, setCurrentPath] = useState('')
  const [files, setFiles] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [fileLoading, setFileLoading] = useState(false)

  // Load directory contents
  const loadDirectory = async (subpath: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/files?path=${encodeURIComponent(trialPath)}&subpath=${encodeURIComponent(subpath)}`)
      if (!res.ok) throw new Error('Failed to load directory')
      const data = await res.json()
      setFiles(data.files)
      setCurrentPath(subpath)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  // Load file contents
  const loadFile = async (filePath: string) => {
    setFileLoading(true)
    setSelectedFile(filePath)
    setFileContent(null)
    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(trialPath)}&file=${encodeURIComponent(filePath)}`)
      if (!res.ok) throw new Error('Failed to load file')

      const contentType = res.headers.get('content-type')
      if (contentType?.includes('application/json')) {
        const data = await res.json()
        // If it's a wrapped text file
        if (data.content !== undefined) {
          setFileContent(data.content)
        } else {
          // It's a raw JSON file
          setFileContent(JSON.stringify(data, null, 2))
        }
      } else {
        const data = await res.json()
        setFileContent(data.content)
      }
    } catch (e) {
      setFileContent(`Error loading file: ${e instanceof Error ? e.message : 'Unknown error'}`)
    } finally {
      setFileLoading(false)
    }
  }

  // Initial load
  useEffect(() => {
    loadDirectory('')
  }, [trialPath])

  const navigateUp = () => {
    const parts = currentPath.split('/').filter(Boolean)
    parts.pop()
    loadDirectory(parts.join('/'))
  }

  const navigateTo = (dir: string) => {
    const newPath = currentPath ? `${currentPath}/${dir}` : dir
    loadDirectory(newPath)
  }

  const getFileIcon = (name: string, type: string) => {
    if (type === 'directory') return <Folder className="w-4 h-4 text-blue-500" />

    const ext = name.split('.').pop()?.toLowerCase()
    switch (ext) {
      case 'json':
        return <FileJson className="w-4 h-4 text-yellow-500" />
      case 'py':
      case 'ts':
      case 'tsx':
      case 'js':
        return <FileCode className="w-4 h-4 text-green-500" />
      case 'txt':
      case 'log':
      case 'md':
        return <FileText className="w-4 h-4 text-gray-500" />
      default:
        return <File className="w-4 h-4 text-gray-400" />
    }
  }

  const formatSize = (size: number | null) => {
    if (size === null) return ''
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
    return `${(size / (1024 * 1024)).toFixed(1)} MB`
  }

  const pathParts = currentPath.split('/').filter(Boolean)

  return (
    <div className="flex flex-col h-full">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1 px-3 py-2 bg-muted/30 border-b border-border text-sm">
        <button
          onClick={() => loadDirectory('')}
          className="hover:text-primary transition-colors font-medium"
        >
          {trialPath.split('/').pop()}
        </button>
        {pathParts.map((part, idx) => (
          <span key={idx} className="flex items-center gap-1">
            <ChevronRight className="w-3 h-3 text-muted-foreground" />
            <button
              onClick={() => loadDirectory(pathParts.slice(0, idx + 1).join('/'))}
              className="hover:text-primary transition-colors"
            >
              {part}
            </button>
          </span>
        ))}
      </div>

      <div className="flex-1 min-h-0">
        <ResizablePanel
          defaultLeftWidth={35}
          minLeftWidth={20}
          maxLeftWidth={60}
          left={
            <div className="h-full overflow-auto">
              {currentPath && (
                <button
                  onClick={navigateUp}
                  className="w-full px-3 py-2 flex items-center gap-2 hover:bg-muted/50 transition-colors text-sm border-b border-border/50"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span className="text-muted-foreground">..</span>
                </button>
              )}

              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : error ? (
                <div className="p-3 text-sm text-red-500">{error}</div>
              ) : (
                <div className="divide-y divide-border/30">
                  {files.map((file) => {
                    const filePath = currentPath ? `${currentPath}/${file.name}` : file.name
                    const isSelected = selectedFile === filePath

                    return (
                      <button
                        key={file.name}
                        onClick={() => {
                          if (file.type === 'directory') {
                            navigateTo(file.name)
                          } else {
                            loadFile(filePath)
                          }
                        }}
                        className={`w-full px-3 py-2 flex items-center gap-2 hover:bg-muted/50 transition-colors text-sm text-left ${
                          isSelected ? 'bg-primary/10' : ''
                        }`}
                      >
                        {getFileIcon(file.name, file.type)}
                        <span className="flex-1 truncate">{file.name}</span>
                        {file.type === 'file' && (
                          <span className="text-xs text-muted-foreground">{formatSize(file.size)}</span>
                        )}
                        {file.type === 'directory' && (
                          <ChevronRight className="w-3 h-3 text-muted-foreground" />
                        )}
                      </button>
                    )
                  })}
                  {files.length === 0 && !loading && (
                    <div className="p-3 text-sm text-muted-foreground text-center">
                      Empty directory
                    </div>
                  )}
                </div>
              )}
            </div>
          }
          right={
            <div className="h-full overflow-auto bg-muted/10">
              {fileLoading ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : selectedFile && fileContent !== null ? (
                <div className="h-full flex flex-col">
                  <div className="px-3 py-2 bg-muted/30 border-b border-border text-xs text-muted-foreground font-mono shrink-0">
                    {selectedFile}
                  </div>
                  <pre className="flex-1 p-3 text-xs font-mono overflow-auto whitespace-pre-wrap break-all">
                    {fileContent}
                  </pre>
                </div>
              ) : (
                <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                  Select a file to view its contents
                </div>
              )}
            </div>
          }
        />
      </div>
    </div>
  )
}
