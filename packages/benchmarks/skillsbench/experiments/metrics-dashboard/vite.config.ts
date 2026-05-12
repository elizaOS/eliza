import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

const TRAJECTORIES_DIR = path.resolve(__dirname, '../../skillsbench-trajectories/jobs')

// Plugin to serve trajectory data via API
function trajectoryApiPlugin(): Plugin {
  return {
    name: 'trajectory-api',
    configureServer(server) {
      // Handle API routes
      server.middlewares.use((req, res, next) => {
        const reqUrl = req.url || ''

        // Parse the URL
        const url = new URL(reqUrl, 'http://localhost')
        const pathname = url.pathname

        if (pathname === '/api/trajectory') {
          const trialPath = url.searchParams.get('path')

          if (!trialPath) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Missing path parameter' }))
            return
          }

          // Sanitize path to prevent directory traversal
          const sanitizedPath = trialPath.replace(/\.\./g, '')
          const trajectoryPath = path.join(TRAJECTORIES_DIR, sanitizedPath, 'agent', 'trajectory.json')

          if (!fs.existsSync(trajectoryPath)) {
            res.statusCode = 404
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Trajectory not found', path: trajectoryPath }))
            return
          }

          try {
            const content = fs.readFileSync(trajectoryPath, 'utf-8')
            res.setHeader('Content-Type', 'application/json')
            res.end(content)
          } catch (e) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Failed to read trajectory', details: String(e) }))
          }
          return
        }

        if (pathname === '/api/episode') {
          const trialPath = url.searchParams.get('path')
          const episode = url.searchParams.get('episode')
          const file = url.searchParams.get('file') || 'prompt.txt'

          if (!trialPath || episode === null) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Missing path or episode parameter' }))
            return
          }

          const sanitizedPath = trialPath.replace(/\.\./g, '')
          const filePath = path.join(TRAJECTORIES_DIR, sanitizedPath, 'agent', `episode-${episode}`, file)

          if (!fs.existsSync(filePath)) {
            res.statusCode = 404
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Episode file not found' }))
            return
          }

          try {
            const content = fs.readFileSync(filePath, 'utf-8')
            res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'text/plain')
            res.end(content)
          } catch (e) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Failed to read episode file', details: String(e) }))
          }
          return
        }

        // List directory contents
        if (pathname === '/api/files') {
          const trialPath = url.searchParams.get('path')
          const subPath = url.searchParams.get('subpath') || ''

          if (!trialPath) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Missing path parameter' }))
            return
          }

          const sanitizedPath = trialPath.replace(/\.\./g, '')
          const sanitizedSubPath = subPath.replace(/\.\./g, '')
          const dirPath = path.join(TRAJECTORIES_DIR, sanitizedPath, sanitizedSubPath)

          if (!fs.existsSync(dirPath)) {
            res.statusCode = 404
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Directory not found' }))
            return
          }

          try {
            const stat = fs.statSync(dirPath)
            if (!stat.isDirectory()) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'Path is not a directory' }))
              return
            }

            const entries = fs.readdirSync(dirPath, { withFileTypes: true })
            const files = entries.map(e => ({
              name: e.name,
              type: e.isDirectory() ? 'directory' : 'file',
              size: e.isFile() ? fs.statSync(path.join(dirPath, e.name)).size : null,
            })).sort((a, b) => {
              // Directories first, then files
              if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
              return a.name.localeCompare(b.name)
            })

            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ path: sanitizedSubPath || '/', files }))
          } catch (e) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Failed to list directory', details: String(e) }))
          }
          return
        }

        // Read file contents
        if (pathname === '/api/file') {
          const trialPath = url.searchParams.get('path')
          const filePath = url.searchParams.get('file')

          if (!trialPath || !filePath) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Missing path or file parameter' }))
            return
          }

          const sanitizedPath = trialPath.replace(/\.\./g, '')
          const sanitizedFile = filePath.replace(/\.\./g, '')
          const fullPath = path.join(TRAJECTORIES_DIR, sanitizedPath, sanitizedFile)

          if (!fs.existsSync(fullPath)) {
            res.statusCode = 404
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'File not found' }))
            return
          }

          try {
            const stat = fs.statSync(fullPath)
            if (stat.isDirectory()) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'Path is a directory, not a file' }))
              return
            }

            // Limit file size to 5MB
            if (stat.size > 5 * 1024 * 1024) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'File too large', size: stat.size }))
              return
            }

            const content = fs.readFileSync(fullPath, 'utf-8')
            const ext = path.extname(fullPath).toLowerCase()
            const isJson = ext === '.json'

            res.setHeader('Content-Type', isJson ? 'application/json' : 'text/plain')
            res.end(isJson ? content : JSON.stringify({ content, size: stat.size }))
          } catch (e) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Failed to read file', details: String(e) }))
          }
          return
        }

        if (pathname === '/api/episodes') {
          const trialPath = url.searchParams.get('path')

          if (!trialPath) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Missing path parameter' }))
            return
          }

          const sanitizedPath = trialPath.replace(/\.\./g, '')
          const agentDir = path.join(TRAJECTORIES_DIR, sanitizedPath, 'agent')

          if (!fs.existsSync(agentDir)) {
            res.statusCode = 404
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Agent directory not found' }))
            return
          }

          try {
            const entries = fs.readdirSync(agentDir, { withFileTypes: true })
            const episodes = entries
              .filter(e => e.isDirectory() && e.name.startsWith('episode-'))
              .map(e => parseInt(e.name.replace('episode-', ''), 10))
              .sort((a, b) => a - b)

            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ episodes }))
          } catch (e) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Failed to list episodes', details: String(e) }))
          }
          return
        }

        // Pass to next middleware
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [react()], // trajectoryApiPlugin() disabled - using Express server instead
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
