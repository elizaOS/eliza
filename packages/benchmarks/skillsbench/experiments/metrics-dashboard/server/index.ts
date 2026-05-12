import express from 'express'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
app.use(cors())

const TRAJECTORIES_DIR = path.resolve(__dirname, '../../../skillsbench-trajectories/jobs')

// Types (matching the frontend types)
interface ExceptionInfo {
  exception_type: string
  exception_message: string
  exception_traceback: string
  occurred_at: string
}

interface ProcessedTrial {
  id: string
  jobName: string
  taskName: string
  trialName: string
  trialPath: string
  agent: string
  model: string
  provider: string
  reward: number | null
  status: 'pass' | 'fail' | 'error' | 'timeout'
  costUsd: number | null
  durationMs: number
  inputTokens: number | null
  outputTokens: number | null
  cacheTokens: number | null
  exceptionInfo: ExceptionInfo | null
  startedAt: string
  finishedAt: string
  nEpisodes: number | null
}

interface JobSummary {
  jobName: string
  jobStatus: 'running' | 'completed'
  expectedTrials: number
  completedTrials: number
  passedTrials: number
  failedTrials: number
  erroredTrials: number
  passRate: number
  totalCost: number
  startedAt: string
  finishedAt: string | null
  lastModified: string
}

interface ErrorGroup {
  exceptionType: string
  count: number
  trials: ProcessedTrial[]
}

interface MetricsRegistry {
  generatedAt: string
  jobs: JobSummary[]
  trials: ProcessedTrial[]
  errorGroups: ErrorGroup[]
}

function findResultFiles(dir: string): string[] {
  const results: string[] = []

  if (!fs.existsSync(dir)) return results

  const entries = fs.readdirSync(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // Look for result.json in subdirectories (trial folders)
      const resultFile = path.join(fullPath, 'result.json')
      if (fs.existsSync(resultFile)) {
        results.push(resultFile)
      }
    }
  }

  return results
}

function processTrialResult(trial: any, jobName: string, trialPath: string): ProcessedTrial {
  const agentResult = trial.agent_result || {}
  const verifierResult = trial.verifier_result || {}
  const config = trial.config || {}
  const agentConfig = config.agent || {}

  const reward = verifierResult?.rewards?.reward ?? null
  const hasException = trial.exception_info !== null
  const isTimeout = hasException &&
    (trial.exception_info?.exception_type?.toLowerCase().includes('timeout') || false)

  let status: 'pass' | 'fail' | 'error' | 'timeout'
  if (isTimeout) {
    status = 'timeout'
  } else if (hasException) {
    status = 'error'
  } else if (reward !== null && reward >= 1.0) {
    status = 'pass'
  } else {
    status = 'fail'
  }

  const startedAt = trial.started_at || ''
  const finishedAt = trial.finished_at || ''
  const durationMs = startedAt && finishedAt
    ? new Date(finishedAt).getTime() - new Date(startedAt).getTime()
    : 0

  const modelName = agentConfig.model_name || ''
  const modelParts = modelName.split('/')
  const provider = modelParts.length > 1 ? modelParts[0] : 'unknown'
  const model = modelParts.length > 1 ? modelParts.slice(1).join('/') : modelName

  return {
    id: trial.id || '',
    jobName,
    taskName: trial.task_name || '',
    trialName: trial.trial_name || '',
    trialPath,
    agent: agentConfig.name || trial.agent_info?.name || 'unknown',
    model,
    provider,
    reward,
    status,
    costUsd: agentResult.cost_usd ?? null,
    durationMs,
    inputTokens: agentResult.n_input_tokens ?? null,
    outputTokens: agentResult.n_output_tokens ?? null,
    cacheTokens: agentResult.n_cache_tokens ?? null,
    exceptionInfo: trial.exception_info || null,
    startedAt,
    finishedAt,
    nEpisodes: agentResult.metadata?.n_episodes ?? null,
  }
}

function generateMetrics(): MetricsRegistry {
  const registry: MetricsRegistry = {
    generatedAt: new Date().toISOString(),
    jobs: [],
    trials: [],
    errorGroups: [],
  }

  if (!fs.existsSync(TRAJECTORIES_DIR)) {
    console.log(`Trajectories directory not found: ${TRAJECTORIES_DIR}`)
    return registry
  }

  const jobDirs = fs.readdirSync(TRAJECTORIES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.includes('backup'))

  const jobSummaries: Map<string, JobSummary> = new Map()
  const errorGroupsMap: Map<string, ProcessedTrial[]> = new Map()

  for (const jobDir of jobDirs) {
    const jobPath = path.join(TRAJECTORIES_DIR, jobDir.name)
    const resultFiles = findResultFiles(jobPath)

    const jobResultPath = path.join(jobPath, 'result.json')
    const jobConfigPath = path.join(jobPath, 'config.json')
    let jobStatus: 'running' | 'completed' = 'running'
    let expectedTrials = 0
    let finishedAt: string | null = null

    const jobStats = fs.statSync(jobPath)
    const lastModified = jobStats.mtime.toISOString()

    if (fs.existsSync(jobResultPath)) {
      try {
        const jobResult = JSON.parse(fs.readFileSync(jobResultPath, 'utf-8'))
        if (jobResult.finished_at) {
          jobStatus = 'completed'
          finishedAt = jobResult.finished_at
        }
        expectedTrials = jobResult.n_total_trials || 0
      } catch {
        // Ignore parse errors
      }
    }

    if (expectedTrials === 0 && fs.existsSync(jobConfigPath)) {
      try {
        const jobConfig = JSON.parse(fs.readFileSync(jobConfigPath, 'utf-8'))
        expectedTrials = jobConfig.n_total_trials || 0
      } catch {
        // Ignore parse errors
      }
    }

    // If still no expected trials, count trial directories
    if (expectedTrials === 0) {
      const entries = fs.readdirSync(jobPath, { withFileTypes: true })
      expectedTrials = entries.filter(e =>
        e.isDirectory() && !e.name.startsWith('.')
      ).length
    }

    // Track total reward sum for mean calculation (like old monitor)
    let totalRewardSum = 0

    jobSummaries.set(jobDir.name, {
      jobName: jobDir.name,
      jobStatus,
      expectedTrials,
      completedTrials: 0,
      passedTrials: 0,
      failedTrials: 0,
      erroredTrials: 0,
      passRate: 0,
      totalCost: 0,
      startedAt: '',
      finishedAt,
      lastModified,
    })

    for (const resultFile of resultFiles) {
      try {
        const content = fs.readFileSync(resultFile, 'utf-8')
        const trial = JSON.parse(content)
        const trialDir = path.dirname(resultFile)
        const trialPath = path.relative(TRAJECTORIES_DIR, trialDir)
        const processed = processTrialResult(trial, jobDir.name, trialPath)
        registry.trials.push(processed)

        const summary = jobSummaries.get(jobDir.name)!
        summary.completedTrials++
        summary.totalCost += processed.costUsd ?? 0

        // Always add reward to sum for mean calculation (matches old monitor)
        const reward = processed.reward ?? 0
        totalRewardSum += reward

        // Count passes based on reward >= 1 (regardless of error status)
        if (reward >= 1.0) {
          summary.passedTrials++
        } else if (processed.exceptionInfo) {
          summary.erroredTrials++
        } else {
          summary.failedTrials++
        }

        if (!summary.startedAt || processed.startedAt < summary.startedAt) {
          summary.startedAt = processed.startedAt
        }

        if (processed.exceptionInfo) {
          const errType = processed.exceptionInfo.exception_type
          if (!errorGroupsMap.has(errType)) {
            errorGroupsMap.set(errType, [])
          }
          errorGroupsMap.get(errType)!.push(processed)
        }
      } catch (e) {
        console.error(`Error processing ${resultFile}: ${e}`)
      }
    }

    // Calculate pass rate as MEAN REWARD (sum of rewards / trials) to match old monitor
    const summary = jobSummaries.get(jobDir.name)!
    summary.passRate = summary.completedTrials > 0 ? totalRewardSum / summary.completedTrials : 0
  }

  registry.jobs = Array.from(jobSummaries.values())
    .sort((a, b) => b.lastModified.localeCompare(a.lastModified))

  registry.errorGroups = Array.from(errorGroupsMap.entries())
    .map(([exceptionType, trials]) => ({
      exceptionType,
      count: trials.length,
      trials,
    }))
    .sort((a, b) => b.count - a.count)

  return registry
}

// Helper to run shell commands
import { exec } from 'child_process'
import { promisify } from 'util'
const execAsync = promisify(exec)

// Helper with timeout for system commands
async function execWithTimeout(cmd: string, timeoutMs = 5000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = exec(cmd, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error && error.killed) {
        resolve({ stdout: '', stderr: 'timeout' })
      } else if (error) {
        reject(error)
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

interface HealthStatus {
  timestamp: string
  status: 'healthy' | 'warning' | 'critical'
  issues: string[]
  metrics: {
    harborProcesses: number
    dockerContainers: {
      total: number
      stuckCount: number
      stuckContainers: string[]
    }
    disk: {
      usedPercent: number
      availableGb: number
    }
    memory: {
      usedPercent: number
      availableGb: number
    }
    trials: {
      completedLastHour: number
      errorsLastHour: number
      throughputPerHour: number
    }
  }
}

async function getSystemHealth(): Promise<HealthStatus> {
  const issues: string[] = []
  let status: 'healthy' | 'warning' | 'critical' = 'healthy'

  // Check harbor processes
  let harborProcesses = 0
  try {
    const { stdout } = await execWithTimeout('ps aux | grep -E "harbor (run|jobs)" | grep -v grep | wc -l', 3000)
    harborProcesses = parseInt(stdout.trim()) || 0
  } catch {}

  // Check docker containers
  let totalContainers = 0
  let stuckCount = 0
  let stuckContainers: string[] = []
  try {
    const { stdout: countOut } = await execWithTimeout('docker ps -q 2>/dev/null | wc -l', 5000)
    totalContainers = parseInt(countOut.trim()) || 0

    const { stdout: stuckOut } = await execWithTimeout('docker ps --format "{{.Names}} {{.RunningFor}}" 2>/dev/null | grep "hour" || true', 10000)
    const stuckLines = stuckOut.trim().split('\n').filter(l => l.trim())
    stuckCount = stuckLines.length
    stuckContainers = stuckLines.slice(0, 10).map(l => l.split(' ')[0])
  } catch {}

  // Check disk space
  let diskUsedPercent = 0
  let diskAvailableGb = 0
  try {
    const { stdout } = await execWithTimeout("df -h / | tail -1 | awk '{print $5, $4}'", 3000)
    const parts = stdout.trim().split(/\s+/)
    diskUsedPercent = parseInt(parts[0]?.replace('%', '') || '0')
    const avail = parts[1] || '0'
    if (avail.endsWith('T')) diskAvailableGb = parseFloat(avail) * 1024
    else if (avail.endsWith('G')) diskAvailableGb = parseFloat(avail)
    else if (avail.endsWith('M')) diskAvailableGb = parseFloat(avail) / 1024
  } catch {}

  // Check memory
  let memUsedPercent = 0
  let memAvailableGb = 0
  try {
    const { stdout } = await execWithTimeout("free -g | grep Mem | awk '{print $3, $7, $2}'", 3000)
    const parts = stdout.trim().split(/\s+/)
    const used = parseInt(parts[0] || '0')
    const available = parseInt(parts[1] || '0')
    const total = parseInt(parts[2] || '1')
    memAvailableGb = available
    memUsedPercent = Math.round((used / total) * 100)
  } catch {}

  // Check trial throughput (last hour)
  let completedLastHour = 0
  let errorsLastHour = 0
  try {
    const { stdout: completedOut } = await execWithTimeout(`find ${TRAJECTORIES_DIR} -name "result.json" -mmin -60 -size +0 2>/dev/null | wc -l`, 15000)
    completedLastHour = parseInt(completedOut.trim()) || 0

    const { stdout: errorsOut } = await execWithTimeout(`find ${TRAJECTORIES_DIR} -name "exception.txt" -mmin -60 2>/dev/null | wc -l`, 15000)
    errorsLastHour = parseInt(errorsOut.trim()) || 0
  } catch {}

  // Determine status and issues
  if (harborProcesses === 0) {
    issues.push('No harbor processes running - experiments may have stopped')
    status = 'critical'
  } else if (harborProcesses < 4) {
    issues.push(`Only ${harborProcesses} harbor processes running (expected 4)`)
    status = status === 'healthy' ? 'warning' : status
  }

  if (stuckCount > 10) {
    issues.push(`${stuckCount} containers stuck for >1 hour - blocking trial slots`)
    status = 'critical'
  } else if (stuckCount > 0) {
    issues.push(`${stuckCount} containers running for >1 hour`)
    status = status === 'healthy' ? 'warning' : status
  }

  if (diskUsedPercent > 90) {
    issues.push(`Disk ${diskUsedPercent}% full - may cause failures`)
    status = 'critical'
  } else if (diskUsedPercent > 80) {
    issues.push(`Disk ${diskUsedPercent}% full`)
    status = status === 'healthy' ? 'warning' : status
  }

  if (memUsedPercent > 90) {
    issues.push(`Memory ${memUsedPercent}% used`)
    status = status === 'healthy' ? 'warning' : status
  }

  if (harborProcesses > 0 && completedLastHour < 10) {
    issues.push(`Low throughput: only ${completedLastHour} trials/hour`)
    status = status === 'healthy' ? 'warning' : status
  }

  if (errorsLastHour > completedLastHour * 0.5 && errorsLastHour > 5) {
    issues.push(`High error rate: ${errorsLastHour} errors in last hour`)
    status = status === 'healthy' ? 'warning' : status
  }

  return {
    timestamp: new Date().toISOString(),
    status,
    issues,
    metrics: {
      harborProcesses,
      dockerContainers: {
        total: totalContainers,
        stuckCount,
        stuckContainers,
      },
      disk: {
        usedPercent: diskUsedPercent,
        availableGb: diskAvailableGb,
      },
      memory: {
        usedPercent: memUsedPercent,
        availableGb: memAvailableGb,
      },
      trials: {
        completedLastHour,
        errorsLastHour,
        throughputPerHour: completedLastHour,
      },
    },
  }
}

// Health monitoring endpoint
app.get('/api/health', async (req, res) => {
  try {
    const health = await getSystemHealth()
    res.json(health)
  } catch (error) {
    console.error('Error getting health status:', error)
    res.status(500).json({ error: 'Failed to get health status' })
  }
})

// Kill stuck containers endpoint
app.post('/api/kill-stuck', express.json(), async (req, res) => {
  try {
    const { stdout } = await execAsync('docker ps --format "{{.Names}} {{.RunningFor}}" | grep "hour" | cut -d" " -f1 | xargs -r docker stop 2>/dev/null || true')
    const killed = stdout.trim().split('\n').filter(l => l.trim())
    console.log(`Killed ${killed.length} stuck containers`)
    res.json({ success: true, killedCount: killed.length, containers: killed })
  } catch (error) {
    console.error('Error killing stuck containers:', error)
    res.status(500).json({ error: 'Failed to kill stuck containers' })
  }
})

// Kill a single container
app.post('/api/kill-container', express.json(), async (req, res) => {
  try {
    const { containerName } = req.body
    if (!containerName || typeof containerName !== 'string') {
      return res.status(400).json({ error: 'Missing containerName' })
    }
    // Sanitize container name to prevent injection
    const safeName = containerName.replace(/[^a-zA-Z0-9_-]/g, '')
    await execAsync(`docker stop ${safeName} 2>/dev/null || true`)
    console.log(`Killed container: ${safeName}`)
    res.json({ success: true, container: safeName })
  } catch (error) {
    console.error('Error killing container:', error)
    res.status(500).json({ error: 'Failed to kill container' })
  }
})

// Get detailed info about stuck containers
app.get('/api/stuck-containers', async (_req, res) => {
  try {
    interface StuckContainer {
      name: string
      runningFor: string
      runningForMs: number
      status: string
      image: string
      taskName: string | null
      trialId: string | null
      jobName: string | null
      trialPath: string | null
      logs: string
    }

    const containers: StuckContainer[] = []

    // Get containers running for more than 1 hour with detailed info
    const { stdout } = await execAsync('docker ps --format "{{.Names}}|{{.Status}}|{{.RunningFor}}|{{.Image}}" 2>/dev/null || true')
    const lines = stdout.trim().split('\n').filter(l => l.trim())

    for (const line of lines) {
      const [name, status, runningFor, image] = line.split('|')
      if (!name || !runningFor) continue

      // Check if running for more than 1 hour
      if (!runningFor.includes('hour')) continue

      // Parse running time to milliseconds
      let runningForMs = 0
      const hourMatch = runningFor.match(/(\d+)\s*hour/)
      const minMatch = runningFor.match(/(\d+)\s*minute/)
      if (hourMatch) runningForMs += parseInt(hourMatch[1]) * 3600000
      if (minMatch) runningForMs += parseInt(minMatch[1]) * 60000

      // Parse container name to extract task and trial info
      // Format: <task-name>__<trial-id>-main-1 or <task-name>__<trial-id>-<service>-1
      let taskName: string | null = null
      let trialId: string | null = null
      let jobName: string | null = null
      let trialPath: string | null = null

      const containerMatch = name.match(/^(.+?)__([a-zA-Z0-9]+)/)
      if (containerMatch) {
        taskName = containerMatch[1]
        trialId = containerMatch[2]

        // Try to find the trial in the jobs directory (case-insensitive match on trial ID)
        const jobDirs = fs.readdirSync(TRAJECTORIES_DIR, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.includes('backup'))

        const trialIdLower = trialId.toLowerCase()
        for (const jobDir of jobDirs) {
          const jobPath = path.join(TRAJECTORIES_DIR, jobDir.name)
          const trialDirs = fs.readdirSync(jobPath, { withFileTypes: true })
            .filter(d => d.isDirectory() && d.name.toLowerCase().includes(`__${trialIdLower}`))

          if (trialDirs.length > 0) {
            jobName = jobDir.name
            trialPath = `${jobDir.name}/${trialDirs[0].name}`
            break
          }
        }
      }

      // Get last 50 lines of container logs
      let logs = ''
      try {
        const { stdout: logOut } = await execAsync(`docker logs --tail 50 ${name} 2>&1 || true`, { timeout: 5000 })
        logs = logOut.trim()
      } catch {
        logs = '(Failed to get logs)'
      }

      containers.push({
        name,
        runningFor,
        runningForMs,
        status,
        image,
        taskName,
        trialId,
        jobName,
        trialPath,
        logs,
      })
    }

    // Sort by running time (longest first)
    containers.sort((a, b) => b.runningForMs - a.runningForMs)

    res.json({ count: containers.length, containers })
  } catch (error) {
    console.error('Error getting stuck containers:', error)
    res.status(500).json({ error: 'Failed to get stuck containers' })
  }
})

// Get stale trials (directories without completed result.json)
app.get('/api/stale-trials', (req, res) => {
  try {
    const staleTrials: Array<{
      jobName: string
      trialName: string
      path: string
      startedAt: string | null
      lastModified: string
      hasResultJson: boolean
      resultJsonEmpty: boolean
      ageDurationMs: number
    }> = []

    const jobDirs = fs.readdirSync(TRAJECTORIES_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.includes('backup'))

    for (const jobDir of jobDirs) {
      const jobPath = path.join(TRAJECTORIES_DIR, jobDir.name)
      const trialDirs = fs.readdirSync(jobPath, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))

      for (const trialDir of trialDirs) {
        const trialPath = path.join(jobPath, trialDir.name)
        const resultPath = path.join(trialPath, 'result.json')
        const configPath = path.join(trialPath, 'config.json')

        let hasResultJson = fs.existsSync(resultPath)
        let resultJsonEmpty = false
        let isComplete = false
        let startedAt: string | null = null

        // Check if result.json exists and has finished_at
        if (hasResultJson) {
          try {
            const content = fs.readFileSync(resultPath, 'utf-8')
            if (!content.trim()) {
              resultJsonEmpty = true
            } else {
              const result = JSON.parse(content)
              if (result.finished_at) {
                isComplete = true
              }
              startedAt = result.started_at || null
            }
          } catch {
            resultJsonEmpty = true
          }
        }

        // Get started_at from config if not in result
        if (!startedAt && fs.existsSync(configPath)) {
          try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
            startedAt = config.started_at || null
          } catch {}
        }

        // If not complete, it's stale
        if (!isComplete) {
          const trialStats = fs.statSync(trialPath)
          const lastModified = trialStats.mtime
          const ageDurationMs = Date.now() - lastModified.getTime()

          staleTrials.push({
            jobName: jobDir.name,
            trialName: trialDir.name,
            path: `${jobDir.name}/${trialDir.name}`,
            startedAt,
            lastModified: lastModified.toISOString(),
            hasResultJson,
            resultJsonEmpty,
            ageDurationMs,
          })
        }
      }
    }

    // Sort by age (oldest first)
    staleTrials.sort((a, b) => b.ageDurationMs - a.ageDurationMs)

    res.json({
      count: staleTrials.length,
      trials: staleTrials,
    })
  } catch (error) {
    console.error('Error getting stale trials:', error)
    res.status(500).json({ error: 'Failed to get stale trials' })
  }
})

// Get detailed system info
app.get('/api/system-info', async (req, res) => {
  try {
    const info: any = {}

    // CPU info
    try {
      const { stdout } = await execWithTimeout("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'", 3000)
      info.cpuUsage = parseFloat(stdout.trim()) || 0
    } catch { info.cpuUsage = 0 }

    // Memory detailed
    try {
      const { stdout } = await execWithTimeout("free -m | grep Mem", 3000)
      const parts = stdout.trim().split(/\s+/)
      info.memory = {
        totalMb: parseInt(parts[1]) || 0,
        usedMb: parseInt(parts[2]) || 0,
        freeMb: parseInt(parts[3]) || 0,
        availableMb: parseInt(parts[6]) || 0,
      }
    } catch { info.memory = {} }

    // Disk detailed
    try {
      const { stdout } = await execWithTimeout("df -h / | tail -1", 3000)
      const parts = stdout.trim().split(/\s+/)
      info.disk = {
        total: parts[1],
        used: parts[2],
        available: parts[3],
        usedPercent: parseInt(parts[4]?.replace('%', '') || '0'),
        mountPoint: parts[5],
      }
    } catch { info.disk = {} }

    // Docker containers detailed
    try {
      const { stdout } = await execWithTimeout('docker ps --format "{{.Names}}|{{.Status}}|{{.RunningFor}}|{{.Image}}" 2>/dev/null || true', 10000)
      const containers = stdout.trim().split('\n').filter(l => l.trim()).map(line => {
        const [name, status, runningFor, image] = line.split('|')
        return { name, status, runningFor, image }
      })
      info.containers = containers
    } catch { info.containers = [] }

    // Harbor processes detailed
    try {
      const { stdout } = await execWithTimeout('ps aux | grep "harbor" | grep -v grep || true', 3000)
      const processes = stdout.trim().split('\n').filter(l => l.trim()).map(line => {
        const parts = line.split(/\s+/)
        return {
          pid: parts[1],
          cpu: parts[2],
          mem: parts[3],
          command: parts.slice(10).join(' ').slice(0, 100),
        }
      })
      info.harborProcesses = processes
    } catch { info.harborProcesses = [] }

    // GPU info (if nvidia-smi available)
    try {
      const { stdout } = await execWithTimeout('nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits 2>/dev/null || echo ""', 3000)
      if (stdout.trim()) {
        const gpus = stdout.trim().split('\n').map(line => {
          const [name, memUsed, memTotal, utilization] = line.split(', ')
          return { name, memUsedMb: parseInt(memUsed), memTotalMb: parseInt(memTotal), utilizationPercent: parseInt(utilization) }
        })
        info.gpus = gpus
      }
    } catch { info.gpus = [] }

    res.json(info)
  } catch (error) {
    console.error('Error getting system info:', error)
    res.status(500).json({ error: 'Failed to get system info' })
  }
})

// Get running harbor jobs with their commands and configs
app.get('/api/harbor-jobs', async (req, res) => {
  try {
    interface HarborJob {
      pid: string
      type: 'run' | 'resume' | 'unknown'
      command: string
      configFile: string | null
      outputDir: string | null
      jobName: string | null
      config: any | null
      cpu: string
      mem: string
      startedAt: string | null
    }

    const jobs: HarborJob[] = []

    // Get harbor processes with full command
    const { stdout } = await execAsync('ps -eo pid,pcpu,pmem,lstart,args | grep -E "harbor (run|jobs resume)" | grep -v grep || true')
    const lines = stdout.trim().split('\n').filter(l => l.trim())

    for (const line of lines) {
      // Parse: PID %CPU %MEM STARTED(day month date time year) COMMAND
      const match = line.match(/^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/)
      if (!match) continue

      const [, pid, cpu, mem, startedAt, fullCommand] = match
      const job: HarborJob = {
        pid,
        type: 'unknown',
        command: fullCommand,
        configFile: null,
        outputDir: null,
        jobName: null,
        config: null,
        cpu,
        mem,
        startedAt,
      }

      // Parse command type and extract info
      if (fullCommand.includes('harbor run')) {
        job.type = 'run'

        // Extract --config path
        const configMatch = fullCommand.match(/--config\s+(\S+)/)
        if (configMatch) {
          job.configFile = configMatch[1]

          // Try to read the config file
          const configPath = path.isAbsolute(configMatch[1])
            ? configMatch[1]
            : path.join('/home/suzilewie/projects/SkillsBench', configMatch[1])

          if (fs.existsSync(configPath)) {
            try {
              const configContent = fs.readFileSync(configPath, 'utf-8')
              // Parse YAML-like config (simple key: value parsing)
              const config: any = {}
              for (const configLine of configContent.split('\n')) {
                const kvMatch = configLine.match(/^(\w+):\s*(.+)$/)
                if (kvMatch) {
                  config[kvMatch[1]] = kvMatch[2].trim()
                }
              }
              job.config = config
              job.jobName = config.job_name || config.name || path.basename(configPath, '.yaml')
              job.outputDir = config.output_dir || config.trials_dir || null
            } catch {}
          }
        }
      } else if (fullCommand.includes('harbor jobs resume')) {
        job.type = 'resume'

        // Extract -p path
        const pathMatch = fullCommand.match(/-p\s+(\S+)/)
        if (pathMatch) {
          job.outputDir = pathMatch[1]
          job.jobName = path.basename(pathMatch[1])

          // Try to read job config.json
          const configPath = path.isAbsolute(pathMatch[1])
            ? path.join(pathMatch[1], 'config.json')
            : path.join('/home/suzilewie/projects/SkillsBench', pathMatch[1], 'config.json')

          if (fs.existsSync(configPath)) {
            try {
              job.config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
              job.configFile = configPath
            } catch {}
          }
        }
      }

      jobs.push(job)
    }

    res.json({ count: jobs.length, jobs })
  } catch (error) {
    console.error('Error getting harbor jobs:', error)
    res.status(500).json({ error: 'Failed to get harbor jobs' })
  }
})

// Get trial activity for a job (completed + in-progress)
app.get('/api/job-activity', (req, res) => {
  try {
    const jobName = req.query.job as string
    const agentFilter = req.query.agent as string | undefined
    const modelFilter = req.query.model as string | undefined

    if (!jobName) {
      return res.status(400).json({ error: 'Missing job parameter' })
    }

    const normalizedJob = path.normalize(jobName).replace(/^(\.\.(\/|\\|$))+/, '')
    const jobPath = path.join(TRAJECTORIES_DIR, normalizedJob)

    if (!jobPath.startsWith(TRAJECTORIES_DIR)) {
      return res.status(403).json({ error: 'Access denied' })
    }

    if (!fs.existsSync(jobPath)) {
      return res.status(404).json({ error: 'Job not found' })
    }

    const completedTrials: Array<{
      trialName: string
      taskName: string
      agent: string
      model: string
      status: string
      reward: number | null
      finishedAt: string
      durationMs: number
    }> = []

    const inProgressTrials: Array<{
      trialName: string
      taskName: string
      agent: string
      model: string
      startedAt: string | null
      lastModified: string
      ageDurationMs: number
    }> = []

    const trialDirs = fs.readdirSync(jobPath, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))

    for (const trialDir of trialDirs) {
      const trialPath = path.join(jobPath, trialDir.name)
      const resultPath = path.join(trialPath, 'result.json')
      const configPath = path.join(trialPath, 'config.json')

      let agent = 'unknown'
      let model = 'unknown'
      let taskName = trialDir.name.split('__')[0] || trialDir.name

      // Get agent/model from config.json first
      if (fs.existsSync(configPath)) {
        try {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
          agent = config.agent?.name || 'unknown'
          model = config.agent?.model_name || 'unknown'
          taskName = config.task?.path?.split('/').pop() || taskName
        } catch {}
      }

      // Fallback: get agent/model from result.json if still unknown
      if ((agent === 'unknown' || model === 'unknown') && fs.existsSync(resultPath)) {
        try {
          const content = fs.readFileSync(resultPath, 'utf-8')
          if (content.trim()) {
            const result = JSON.parse(content)
            if (agent === 'unknown') agent = result.config?.agent?.name || 'unknown'
            if (model === 'unknown') model = result.config?.agent?.model_name || 'unknown'
          }
        } catch {}
      }

      // Apply filters
      if (agentFilter && agent !== agentFilter) continue
      if (modelFilter && model !== modelFilter) continue

      // Use trajectory.json mtime for more accurate "running time" (directory mtime doesn't update when files inside subdirs change)
      const trajectoryPath = path.join(trialPath, 'agent', 'trajectory.json')
      let lastModified: Date
      if (fs.existsSync(trajectoryPath)) {
        lastModified = fs.statSync(trajectoryPath).mtime
      } else {
        lastModified = fs.statSync(trialPath).mtime
      }

      // Check result.json
      let isComplete = false
      let finishedAt: string | null = null
      let startedAt: string | null = null
      let reward: number | null = null
      let status = 'running'
      let durationMs = 0

      if (fs.existsSync(resultPath)) {
        try {
          const content = fs.readFileSync(resultPath, 'utf-8')
          if (content.trim()) {
            const result = JSON.parse(content)
            if (result.finished_at) {
              isComplete = true
              finishedAt = result.finished_at
              startedAt = result.started_at
              reward = result.reward ?? null

              if (result.exception_info) {
                status = 'error'
              } else if (reward !== null && reward >= 1) {
                status = 'pass'
              } else {
                status = 'fail'
              }

              if (startedAt && finishedAt) {
                durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
              }
            } else {
              startedAt = result.started_at
            }
          }
        } catch {}
      }

      if (isComplete && finishedAt) {
        completedTrials.push({
          trialName: trialDir.name,
          taskName,
          agent,
          model,
          status,
          reward,
          finishedAt,
          durationMs,
        })
      } else {
        inProgressTrials.push({
          trialName: trialDir.name,
          taskName,
          agent,
          model,
          startedAt,
          lastModified: lastModified.toISOString(),
          ageDurationMs: Date.now() - lastModified.getTime(),
        })
      }
    }

    // Sort completed by finishedAt (most recent first)
    completedTrials.sort((a, b) => new Date(b.finishedAt).getTime() - new Date(a.finishedAt).getTime())

    // Sort in-progress by age (oldest first, likely stuck)
    inProgressTrials.sort((a, b) => b.ageDurationMs - a.ageDurationMs)

    res.json({
      jobName,
      completedCount: completedTrials.length,
      inProgressCount: inProgressTrials.length,
      recentCompleted: completedTrials.slice(0, 100), // Last 100 completed
      inProgress: inProgressTrials,
    })
  } catch (error) {
    console.error('Error getting job activity:', error)
    res.status(500).json({ error: 'Failed to get job activity' })
  }
})

// API endpoint
app.get('/api/metrics', (req, res) => {
  try {
    const metrics = generateMetrics()
    res.json(metrics)
  } catch (error) {
    console.error('Error generating metrics:', error)
    res.status(500).json({ error: 'Failed to generate metrics' })
  }
})

// Trajectory endpoint - load trajectory from various formats
app.get('/api/trajectory', (req, res) => {
  try {
    const trialPath = req.query.path as string
    if (!trialPath) {
      return res.status(400).json({ error: 'Missing path parameter' })
    }

    // Security: prevent directory traversal
    const normalizedPath = path.normalize(trialPath).replace(/^(\.\.(\/|\\|$))+/, '')
    const agentDir = path.join(TRAJECTORIES_DIR, normalizedPath, 'agent')

    // Verify the path is within the trajectories directory
    if (!agentDir.startsWith(TRAJECTORIES_DIR)) {
      return res.status(403).json({ error: 'Access denied' })
    }

    // Try multiple trajectory file formats
    const possibleFiles = [
      { path: path.join(agentDir, 'trajectory.json'), format: 'json' },
      { path: path.join(agentDir, 'claude-code.txt'), format: 'jsonl' },
      { path: path.join(agentDir, 'codex.txt'), format: 'jsonl' },
      { path: path.join(agentDir, 'gemini-cli.trajectory.json'), format: 'json' },
    ]

    let content: string | null = null
    let format: string = 'json'

    for (const file of possibleFiles) {
      if (fs.existsSync(file.path)) {
        content = fs.readFileSync(file.path, 'utf-8')
        format = file.format
        break
      }
    }

    if (!content) {
      return res.status(404).json({ error: 'Trajectory not found' })
    }

    let trajectory: any

    if (format === 'jsonl') {
      // Parse JSONL format (claude-code.txt, codex.txt)
      const lines = content.trim().split('\n').filter(line => line.trim())
      const entries = lines.map(line => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      }).filter(Boolean)

      trajectory = {
        steps: entries.map((entry: any, idx: number) => ({
          step_id: idx,
          source: entry.type || 'unknown',
          message: entry.message?.content?.[0]?.text ||
                   entry.content?.[0]?.text ||
                   (typeof entry.message === 'string' ? entry.message : JSON.stringify(entry).slice(0, 1000)),
          tool_calls: entry.message?.content?.filter((c: any) => c.type === 'tool_use')?.map((t: any) => ({
            name: t.name,
            input: typeof t.input === 'string' ? t.input : JSON.stringify(t.input)
          })) || [],
          metrics: null
        }))
      }
    } else {
      // Parse JSON format
      trajectory = JSON.parse(content)

      // Normalize trajectory format - some agents (terminus) use array, others use {steps: [...]}
      if (Array.isArray(trajectory)) {
        trajectory = {
          steps: trajectory.map((episode: any, idx: number) => ({
            step_id: idx,
            source: 'episode',
            message: episode.prompt || episode.response || JSON.stringify(episode).slice(0, 500),
            tool_calls: episode.commands ? episode.commands.map((cmd: string) => ({ name: 'bash', input: cmd })) : [],
            metrics: null
          }))
        }
      }
    }

    res.json(trajectory)
  } catch (error) {
    console.error('Error loading trajectory:', error)
    res.status(500).json({ error: 'Failed to load trajectory' })
  }
})

// List directory contents
app.get('/api/files', (req, res) => {
  try {
    const trialPath = req.query.path as string
    const subPath = (req.query.subpath as string) || ''

    if (!trialPath) {
      return res.status(400).json({ error: 'Missing path parameter' })
    }

    const normalizedPath = path.normalize(trialPath).replace(/^(\.\.(\/|\\|$))+/, '')
    const normalizedSubPath = path.normalize(subPath).replace(/^(\.\.(\/|\\|$))+/, '')
    const dirPath = path.join(TRAJECTORIES_DIR, normalizedPath, normalizedSubPath)

    if (!dirPath.startsWith(TRAJECTORIES_DIR)) {
      return res.status(403).json({ error: 'Access denied' })
    }

    if (!fs.existsSync(dirPath)) {
      return res.status(404).json({ error: 'Directory not found' })
    }

    const stat = fs.statSync(dirPath)
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' })
    }

    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    const files = entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : 'file',
      size: e.isFile() ? fs.statSync(path.join(dirPath, e.name)).size : null,
    })).sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    res.json({ path: normalizedSubPath || '/', files })
  } catch (error) {
    console.error('Error listing files:', error)
    res.status(500).json({ error: 'Failed to list directory' })
  }
})

// Read file contents
app.get('/api/file', (req, res) => {
  try {
    const trialPath = req.query.path as string
    const filePath = req.query.file as string

    if (!trialPath || !filePath) {
      return res.status(400).json({ error: 'Missing path or file parameter' })
    }

    const normalizedPath = path.normalize(trialPath).replace(/^(\.\.(\/|\\|$))+/, '')
    const normalizedFile = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '')
    const fullPath = path.join(TRAJECTORIES_DIR, normalizedPath, normalizedFile)

    if (!fullPath.startsWith(TRAJECTORIES_DIR)) {
      return res.status(403).json({ error: 'Access denied' })
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File not found' })
    }

    const stat = fs.statSync(fullPath)
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is a directory, not a file' })
    }

    // Limit file size to 5MB
    if (stat.size > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large', size: stat.size })
    }

    const content = fs.readFileSync(fullPath, 'utf-8')
    const ext = path.extname(fullPath).toLowerCase()
    const isJson = ext === '.json'

    if (isJson) {
      res.setHeader('Content-Type', 'application/json')
      res.end(content)
    } else {
      res.json({ content, size: stat.size })
    }
  } catch (error) {
    console.error('Error reading file:', error)
    res.status(500).json({ error: 'Failed to read file' })
  }
})

// Mark a trial as done (for stale/stuck trials)
app.post('/api/mark-done', express.json(), (req, res) => {
  try {
    const { jobName, trialName } = req.body

    if (!jobName || !trialName) {
      return res.status(400).json({ error: 'Missing jobName or trialName' })
    }

    const normalizedJob = path.normalize(jobName).replace(/^(\.\.(\/|\\|$))+/, '')
    const normalizedTrial = path.normalize(trialName).replace(/^(\.\.(\/|\\|$))+/, '')
    const trialPath = path.join(TRAJECTORIES_DIR, normalizedJob, normalizedTrial)
    const resultPath = path.join(trialPath, 'result.json')

    if (!trialPath.startsWith(TRAJECTORIES_DIR)) {
      return res.status(403).json({ error: 'Access denied' })
    }

    if (!fs.existsSync(trialPath)) {
      return res.status(404).json({ error: 'Trial not found' })
    }

    let result: any = {}

    // Load existing result.json if it exists
    if (fs.existsSync(resultPath)) {
      try {
        const content = fs.readFileSync(resultPath, 'utf-8')
        if (content.trim()) {
          result = JSON.parse(content)
        }
      } catch {
        // Start fresh if parse fails
      }
    }

    // Mark as done with error status
    result.finished_at = new Date().toISOString()
    result.manually_stopped = true
    if (!result.reward) result.reward = 0
    if (!result.exception_info) {
      result.exception_info = {
        exception_type: 'ManuallyMarkedDone',
        exception_message: 'Trial was manually marked as done by user',
        traceback: null
      }
    }

    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2))
    console.log(`Marked trial as done: ${jobName}/${trialName}`)

    res.json({ success: true, path: resultPath })
  } catch (error) {
    console.error('Error marking trial as done:', error)
    res.status(500).json({ error: 'Failed to mark trial as done' })
  }
})

// Mark all incomplete trials in a job as done
app.post('/api/stop-job', express.json(), (req, res) => {
  try {
    const { jobName } = req.body

    if (!jobName) {
      return res.status(400).json({ error: 'Missing jobName' })
    }

    const normalizedJob = path.normalize(jobName).replace(/^(\.\.(\/|\\|$))+/, '')
    const jobPath = path.join(TRAJECTORIES_DIR, normalizedJob)

    if (!jobPath.startsWith(TRAJECTORIES_DIR)) {
      return res.status(403).json({ error: 'Access denied' })
    }

    if (!fs.existsSync(jobPath)) {
      return res.status(404).json({ error: 'Job not found' })
    }

    // Find all trial directories without completed result.json
    const entries = fs.readdirSync(jobPath, { withFileTypes: true })
    const trialDirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'))

    let markedCount = 0
    const now = new Date().toISOString()

    for (const trialDir of trialDirs) {
      const resultPath = path.join(jobPath, trialDir.name, 'result.json')
      let needsUpdate = false
      let result: any = {}

      if (fs.existsSync(resultPath)) {
        try {
          const content = fs.readFileSync(resultPath, 'utf-8')
          if (content.trim()) {
            result = JSON.parse(content)
            // Check if already finished
            if (result.finished_at) continue
          }
          needsUpdate = true
        } catch {
          needsUpdate = true
        }
      } else {
        needsUpdate = true
      }

      if (needsUpdate) {
        result.finished_at = now
        result.manually_stopped = true
        if (!result.reward) result.reward = 0
        if (!result.exception_info) {
          result.exception_info = {
            exception_type: 'ManuallyMarkedDone',
            exception_message: 'Trial was manually stopped when job was marked complete',
            traceback: null
          }
        }
        fs.writeFileSync(resultPath, JSON.stringify(result, null, 2))
        markedCount++
      }
    }

    // Also mark the job as completed
    const jobResultPath = path.join(jobPath, 'result.json')
    let jobResult: any = {}
    if (fs.existsSync(jobResultPath)) {
      try {
        const content = fs.readFileSync(jobResultPath, 'utf-8')
        if (content.trim()) jobResult = JSON.parse(content)
      } catch {}
    }
    jobResult.finished_at = now
    jobResult.manually_stopped = true
    jobResult.n_total_trials = trialDirs.length
    fs.writeFileSync(jobResultPath, JSON.stringify(jobResult, null, 2))

    console.log(`Stopped job ${jobName}: marked ${markedCount} incomplete trials as done`)
    res.json({ success: true, markedCount, totalTrials: trialDirs.length })
  } catch (error) {
    console.error('Error stopping job:', error)
    res.status(500).json({ error: 'Failed to stop job' })
  }
})

// Serve static files in production
const distPath = path.join(__dirname, '../dist')
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath))
  // Express 5 requires named parameter for catch-all routes
  app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'))
  })
}

const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
  console.log(`API server running at http://localhost:${PORT}`)
  console.log(`Trajectories directory: ${TRAJECTORIES_DIR}`)
})
