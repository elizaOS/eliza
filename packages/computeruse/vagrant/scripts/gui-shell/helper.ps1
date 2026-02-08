param (
    [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
    [string[]]$Command
)
# PsExec path
$psexec = (where.exe psexec).Split("`n")[0]

if (-not $psexec) {
    Write-Error "PsExec not found. Make sure PSTools is installed and in PATH."
    exit 1
}

# Get current working directory (from where script is run)
$currentDir = (Get-Location).Path

# Resolve any relative paths in the command to absolute paths
$Command = $Command | ForEach-Object {
    if ($_ -match '^\.\\|^\./') {
        # Remove the .\ or ./ prefix before joining paths
        $relativePath = $_ -replace '^\.\\|^\./', ''
        $fullPath = Join-Path $currentDir $relativePath
        if (Test-Path $fullPath) {
            $fullPath
        } else {
            $_
        }
    } else {
        $_
    }
}

# Get active session ID
$activeSession = (query session | Where-Object { $_ -match 'Active' } | ForEach-Object { 
    $parts = $_ -split '\s+' | Where-Object { $_ -ne '' }
    $parts[2]  # ID is the third column
})
if (-not $activeSession) {
    Write-Error "No active session found"
    exit 1
}

# Use PowerShell wrapping when there are arguments
$escapedCommand = $Command | ForEach-Object {
    if ($_ -match '\s') {
        "`"$_`""
    } else {
        $_
    }
}
$escapedCommand = $escapedCommand -join ' '
$escapedCommand = "`"$escapedCommand`""

& $psexec -accepteula -h -d -i $activeSession -u vagrant -p vagrant -w $currentDir powershell.exe -WindowStyle Hidden -Command "$escapedCommand"