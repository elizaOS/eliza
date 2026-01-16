# Browser Extension Hot Reload Watcher
# Watches for changes in the browser extension and reloads it

param(
    [string]$ExtensionPath = "C:\Users\vagrant\computeruse\browser-extension",
    [string]$Browser = "chrome"  # or "edge"
)

Write-Host "Browser Extension Hot Reload Watcher Started" -ForegroundColor Green
Write-Host "Watching: $ExtensionPath" -ForegroundColor Yellow
Write-Host "Browser: $Browser" -ForegroundColor Yellow

# Create file watcher for extension files
$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $ExtensionPath
$watcher.IncludeSubdirectories = $true
$watcher.NotifyFilter = [System.IO.NotifyFilters]::LastWrite -bor [System.IO.NotifyFilters]::FileName
$watcher.EnableRaisingEvents = $false

# Function to reload extension
function Reload-Extension {
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Extension change detected, reloading..." -ForegroundColor Cyan

    if ($Browser -eq "chrome") {
        # Find Chrome process
        $chrome = Get-Process chrome -ErrorAction SilentlyContinue | Select -First 1
        if ($chrome) {
            # Navigate to chrome://extensions and trigger reload
            # Using Chrome debugging protocol
            try {
                # Get debugging port (usually 9222)
                $debugUrl = "http://localhost:9222/json"
                $tabs = Invoke-RestMethod -Uri $debugUrl -UseBasicParsing

                # Find extensions page or create it
                $extensionTab = $tabs | Where-Object { $_.url -like "*chrome://extensions*" }

                if (-not $extensionTab) {
                    # Open extensions page
                    Invoke-RestMethod -Uri "http://localhost:9222/json/new?chrome://extensions" -Method Put
                    Start-Sleep -Seconds 1
                    $tabs = Invoke-RestMethod -Uri $debugUrl -UseBasicParsing
                    $extensionTab = $tabs | Where-Object { $_.url -like "*chrome://extensions*" }
                }

                if ($extensionTab) {
                    # Send reload command via DevTools protocol
                    $wsUrl = $extensionTab.webSocketDebuggerUrl
                    Write-Host "Reloading extension via Chrome DevTools..." -ForegroundColor Yellow

                    # Alternative: Use keyboard shortcut Ctrl+R on extensions page
                    Add-Type @"
                        using System;
                        using System.Runtime.InteropServices;
                        public class Win32 {
                            [DllImport("user32.dll")]
                            public static extern bool SetForegroundWindow(IntPtr hWnd);
                            [DllImport("user32.dll")]
                            public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
                        }
"@
                    $chromeWindow = $chrome.MainWindowHandle
                    [Win32]::SetForegroundWindow($chromeWindow)
                    [Win32]::ShowWindow($chromeWindow, 3)  # Maximize
                    Start-Sleep -Milliseconds 500

                    # Send Ctrl+R
                    Add-Type -AssemblyName System.Windows.Forms
                    [System.Windows.Forms.SendKeys]::SendWait("^r")

                    Write-Host "✓ Extension reloaded" -ForegroundColor Green
                }
            } catch {
                Write-Host "⚠ Could not reload via DevTools, please reload manually" -ForegroundColor Yellow
                Write-Host "  Navigate to chrome://extensions and press Ctrl+R" -ForegroundColor Gray
            }
        } else {
            Write-Host "⚠ Chrome not running. Start Chrome with:" -ForegroundColor Yellow
            Write-Host '  chrome.exe --remote-debugging-port=9222 --load-extension="C:\Users\vagrant\computeruse\browser-extension"' -ForegroundColor Gray
        }
    } elseif ($Browser -eq "edge") {
        # Similar logic for Edge
        Write-Host "Edge extension reload - navigate to edge://extensions and press Ctrl+R" -ForegroundColor Yellow
    }

    # Also rebuild if package.json exists (for webpack/rollup builds)
    $packageJson = Join-Path $ExtensionPath "package.json"
    if (Test-Path $packageJson) {
        Write-Host "Building extension..." -ForegroundColor Yellow
        Push-Location $ExtensionPath
        try {
            & npm run build
            Write-Host "✓ Extension built" -ForegroundColor Green
        } catch {
            Write-Host "⚠ Build failed: $_" -ForegroundColor Red
        } finally {
            Pop-Location
        }
    }
}

# Function to start Chrome with extension in dev mode
function Start-ChromeDev {
    Write-Host "Starting Chrome in development mode..." -ForegroundColor Green

    $chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
    if (-not (Test-Path $chromePath)) {
        $chromePath = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
    }

    if (Test-Path $chromePath) {
        Start-Process $chromePath -ArgumentList `
            "--remote-debugging-port=9222", `
            "--load-extension=`"$ExtensionPath`"", `
            "--disable-extensions-except=`"$ExtensionPath`"", `
            "--user-data-dir=`"C:\Users\vagrant\chrome-debug`""

        Write-Host "✓ Chrome started with extension loaded" -ForegroundColor Green
        Write-Host "  Debugging available at: http://localhost:9222" -ForegroundColor Gray
    } else {
        Write-Host "⚠ Chrome not found. Please install Chrome." -ForegroundColor Red
    }
}

# Check if Chrome is running with debugging
try {
    $test = Invoke-WebRequest -Uri "http://localhost:9222/json" -UseBasicParsing -TimeoutSec 2
    Write-Host "✓ Chrome debugging port is available" -ForegroundColor Green
} catch {
    Write-Host "⚠ Chrome not running in debug mode" -ForegroundColor Yellow
    $answer = Read-Host "Start Chrome in development mode? (y/n)"
    if ($answer -eq 'y') {
        Start-ChromeDev
        Start-Sleep -Seconds 3
    }
}

# Monitor for changes
Write-Host "`nWatching for extension changes. Press Ctrl+C to stop." -ForegroundColor Cyan
Write-Host "Changes will auto-reload in the browser!" -ForegroundColor Green

$lastChange = [DateTime]::MinValue
try {
    while ($true) {
        $result = $watcher.WaitForChanged([System.IO.WatcherChangeTypes]::All, 1000)
        if ($result.TimedOut -eq $false) {
            # Debounce - only reload if last change was >2 seconds ago
            $now = Get-Date
            if (($now - $lastChange).TotalSeconds -gt 2) {
                $lastChange = $now
                Write-Host "Changed: $($result.Name)" -ForegroundColor Gray
                Reload-Extension
            }
        }
    }
} finally {
    $watcher.EnableRaisingEvents = $false
    $watcher.Dispose()
    Write-Host "`nWatcher stopped" -ForegroundColor Red
}