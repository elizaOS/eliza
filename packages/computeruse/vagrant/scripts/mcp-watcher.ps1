# MCP Hot Reload Watcher
# Watches for changes in the MCP binary and restarts the service

param(
    [string]$WatchPath = "C:\Users\vagrant\computeruse\target\release",
    [string]$McpExe = "computeruse-mcp-agent.exe",
    [int]$Port = 8080
)

Write-Host "MCP Hot Reload Watcher Started" -ForegroundColor Green
Write-Host "Watching: $WatchPath\$McpExe" -ForegroundColor Yellow
Write-Host "Port: $Port" -ForegroundColor Yellow

# Create file watcher
$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $WatchPath
$watcher.Filter = $McpExe
$watcher.NotifyFilter = [System.IO.NotifyFilters]::LastWrite
$watcher.EnableRaisingEvents = $false

# Function to restart MCP
function Restart-MCP {
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Change detected, restarting MCP..." -ForegroundColor Cyan

    # Kill existing MCP processes
    $mcpProcesses = Get-Process -Name "computeruse-mcp-agent" -ErrorAction SilentlyContinue
    if ($mcpProcesses) {
        Write-Host "Stopping existing MCP processes..." -ForegroundColor Yellow
        $mcpProcesses | Stop-Process -Force
        Start-Sleep -Seconds 2
    }

    # Start new MCP instance with GUI shell for UI automation
    Write-Host "Starting MCP on port $Port..." -ForegroundColor Green

    # Use PSExec to start in the active user session (Session 1)
    $psexecPath = "C:\Users\vagrant\scoop\apps\pstools\current\PsExec64.exe"
    if (Test-Path $psexecPath) {
        # Start in interactive session for UI automation
        Start-Process $psexecPath -ArgumentList "-accepteula", "-s", "-i", "1", "-d", `
            "$WatchPath\$McpExe", "-t", "http", "--host", "0.0.0.0", "-p", "$Port" `
            -WindowStyle Hidden
    } else {
        # Fallback to regular start
        Start-Process "$WatchPath\$McpExe" -ArgumentList "-t", "http", "--host", "0.0.0.0", "-p", "$Port" `
            -WindowStyle Hidden
    }

    Start-Sleep -Seconds 3

    # Verify MCP is running
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:$Port/health" -UseBasicParsing -TimeoutSec 5
        if ($response.StatusCode -eq 200) {
            Write-Host "✓ MCP started successfully and responding on port $Port" -ForegroundColor Green
            $health = $response.Content | ConvertFrom-Json
            Write-Host "  Status: $($health.status)" -ForegroundColor Gray
        }
    } catch {
        Write-Host "⚠ MCP started but not responding yet on port $Port" -ForegroundColor Yellow
    }
}

# Initial start
Restart-MCP

# Monitor for changes
Write-Host "`nWatching for file changes. Press Ctrl+C to stop." -ForegroundColor Cyan
Write-Host "When you rebuild on host, MCP will auto-restart in VM!" -ForegroundColor Green

try {
    while ($true) {
        $result = $watcher.WaitForChanged([System.IO.WatcherChangeTypes]::Changed, 1000)
        if ($result.TimedOut -eq $false) {
            # Debounce - wait a bit for file write to complete
            Start-Sleep -Milliseconds 500
            Restart-MCP
        }
    }
} finally {
    $watcher.EnableRaisingEvents = $false
    $watcher.Dispose()
    Write-Host "`nWatcher stopped" -ForegroundColor Red
}