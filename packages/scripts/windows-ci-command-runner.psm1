<#
Runs one trusted Windows CI matrix command with a bounded retry for the native
process initialization failure 0xC0000142. The caller retains ownership of
matrix ordering and exits with the returned native status.
#>

Set-StrictMode -Version Latest

$script:WindowsDllInitFailedExitCode = -1073741502
$script:MaximumAttempts = 2

function Invoke-WindowsCiCommand {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,

        [ValidateRange(0, 30000)]
        [int]$RetryDelayMilliseconds = 1000,

        [scriptblock]$CommandInvoker = {
            param([string]$CommandText)

            # Matrix commands are repository-owned workflow input. Out-Host
            # preserves their live output while keeping the returned status scalar.
            Invoke-Expression $CommandText | Out-Host
            return [int]$LASTEXITCODE
        },

        [scriptblock]$Delay = {
            param([int]$Milliseconds)
            Start-Sleep -Milliseconds $Milliseconds
        },

        [scriptblock]$Log = {
            param([string]$Level, [string]$Message)

            switch ($Level) {
                "warning" { Write-Warning $Message }
                "error" { Write-Error -ErrorAction Continue $Message }
                default { Write-Host $Message }
            }
        }
    )

    for ($attempt = 1; $attempt -le $script:MaximumAttempts; $attempt += 1) {
        & $Log "info" "[windows-ci] attempt $attempt/$($script:MaximumAttempts) starting: $Command"
        $code = [int](& $CommandInvoker $Command)
        & $Log "info" "[windows-ci] attempt $attempt/$($script:MaximumAttempts) exited with status $code`: $Command"

        if ($code -eq 0) {
            return 0
        }

        if ($code -ne $script:WindowsDllInitFailedExitCode) {
            return $code
        }

        if ($attempt -eq $script:MaximumAttempts) {
            & $Log "error" "[windows-ci] STATUS_DLL_INIT_FAILED persisted on attempt $attempt/$($script:MaximumAttempts); propagating status $code."
            return $code
        }

        & $Log "warning" "[windows-ci] STATUS_DLL_INIT_FAILED (0xC0000142, $code) on attempt $attempt/$($script:MaximumAttempts). Waiting ${RetryDelayMilliseconds}ms before the single retry."
        & $Delay $RetryDelayMilliseconds
    }
}

Export-ModuleMember -Function Invoke-WindowsCiCommand
